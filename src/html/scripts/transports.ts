// A page's WebTransport sessions on the host's side: what the facade's
// `WebTransport` asks for (the `wt…` ops) carried over the host's seam
// (`HtmlScripts.webTransport`), and what becomes of each session and stream
// told back to the page through entries (`__wt…`).
//
// Only primitives cross, as everywhere on the bridge: a session and a
// stream are numbers, bytes are base64, and what an entry is handed is
// JSON. A page's object never reaches the seam, and nothing of the seam's
// reaches the page — its errors arrive as messages, which the facade makes
// its own `WebTransportError`s of.
import { connectAllowed } from '../csp.js';
import type { CspPolicy } from '../csp.js';
import { badPort } from '../transport.js';
import type {
  HtmlWebTransport,
  WebTransportPriority,
  WebTransportSessionLike,
  WebTransportStats,
  WebTransportStreamLike,
} from '../transport.js';
import type { BufferClass, SetTimeout } from './platform.js';

declare const Buffer: BufferClass;
declare const setTimeout: SetTimeout;

type Primitive = string | number | boolean | null | undefined;

/** Bytes as base64, which is how they cross to the page. */
function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64',
  );
}
function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** A request header the page may not add to a session's CONNECT: the
 *  browser's own, as for a fetch (Fetch 2.2.2). */
const FORBIDDEN =
  /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|user-agent|via|wt-available-protocols)$|^(proxy-|sec-|:)/i;

interface Session {
  id: number;
  session: WebTransportSessionLike | null;
  state: 'connecting' | 'connected' | 'closed' | 'failed';
  /** The figures last had of the connection, which a closed session still
   *  answers with. */
  stats: WebTransportStats | null;
  /** What is asked of it while it is being established. */
  waiting: (() => void)[];
  streams: Set<number>;
}

interface Stream {
  id: number;
  session: Session;
  stream: WebTransportStreamLike;
  /** Whether its reading part is still told of. */
  reading: boolean;
}

/** What the page's sessions are carried over, and how the page is told. */
export interface TransportSeams {
  /** The seam, read as each session opens. */
  connector(): HtmlWebTransport | undefined;
  /** The page's origin, which a session's CONNECT names. */
  origin(): string;
  /** The document's Content Security Policies, which a session is held
   *  to (`connect-src`). Absent, none. */
  policies?(): CspPolicy[];
  /** The page's console, which a refused session is told on. */
  log?(level: string, text: string): void;
  /** An entry of the page's, with its input. */
  tell(entry: string, input: unknown): void;
}

export class PageTransports {
  private readonly _sessions = new Map<number, Session>();
  private readonly _streams = new Map<number, Stream>();
  private _streamSeq = 0;
  private _disposed = false;

  constructor(private readonly _seams: TransportSeams) {}

  /** An op of the facade's whose name starts with `wt`. */
  op(op: string, a: Primitive, b: Primitive, c: Primitive): Primitive {
    const text = (v: Primitive): string => (typeof v === 'string' ? v : '');
    switch (op) {
      case 'wtOpen':
        this._open(Number(a), text(b));
        return null;
      case 'wtClose': {
        const s = this._sessions.get(Number(a));
        if (!s) return null;
        this._closeSession(s, Number(b) >>> 0, text(c));
        return null;
      }
      case 'wtMaxDatagram': {
        const s = this._sessions.get(Number(a));
        return s?.state === 'connected' && s.session
          ? s.session.maxDatagramSize()
          : 0;
      }
      case 'wtDatagram': {
        const s = this._sessions.get(Number(a));
        if (s?.state !== 'connected' || !s.session) return false;
        return s.session.sendDatagram(bytesOf(text(b)), priorityOf(text(c)));
      }
      case 'wtGroup': {
        const s = this._sessions.get(Number(a));
        return s?.session ? s.session.createSendGroup() : 0;
      }
      case 'wtGroupStats':
        this._groupStats(Number(a), Number(b), Number(c));
        return null;
      case 'wtStats':
        this._stats(Number(a), Number(b));
        return null;
      case 'wtCreate':
        this._create(Number(a), Number(b), text(c));
        return null;
      case 'wtRead': {
        const st = this._streams.get(Number(a));
        if (!st) return null;
        const bytes = st.stream.read();
        return bytes && bytes.byteLength ? base64Of(bytes) : null;
      }
      case 'wtWrite':
        this._write(Number(a), Number(b), text(c));
        return null;
      case 'wtFinish':
        this._finish(Number(a), Number(b));
        return null;
      case 'wtReset': {
        const st = this._streams.get(Number(a));
        st?.stream.reset(Number(b) >>> 0);
        return null;
      }
      case 'wtStopSending': {
        const st = this._streams.get(Number(a));
        if (!st) return null;
        st.reading = false;
        st.stream.stopSending(Number(b) >>> 0);
        return null;
      }
      case 'wtPriority': {
        const st = this._streams.get(Number(a));
        st?.stream.prioritize(priorityOf(text(b)));
        return null;
      }
      case 'wtStreamStats':
        this._streamStats(Number(a), Number(b));
        return null;
      case 'wtForget': {
        const st = this._streams.get(Number(a));
        if (st) {
          st.session.streams.delete(st.id);
          this._streams.delete(st.id);
        }
        return null;
      }
      default:
        return null;
    }
  }

  /** The realm goes: every session it had is closed, as a document's are
   *  when it is unloaded. */
  dispose(): void {
    this._disposed = true;
    for (const s of this._sessions.values()) {
      if (s.state === 'connecting' || s.state === 'connected') {
        try {
          s.session?.close(0, '');
        } catch {}
        s.state = 'closed';
      }
    }
    this._sessions.clear();
    this._streams.clear();
  }

  private _tell(entry: string, input: unknown): void {
    if (this._disposed) return;
    this._seams.tell(entry, input);
  }

  private _open(id: number, json: string): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    const s: Session = {
      id,
      session: null,
      state: 'connecting',
      stats: null,
      waiting: [],
      streams: new Set(),
    };
    this._sessions.set(id, s);
    const url = String(raw.url ?? '');
    const fail = (message: string): void => {
      if (s.state !== 'connecting' && s.state !== 'connected') return;
      s.state = 'failed';
      this._wake(s);
      this._tell('__wtFailed', [id, message]);
    };
    // a port no browser connects to is refused before anything is sent
    if (badPort(url)) {
      setTimeout(() => fail(`${url} is not allowed: its port is blocked.`), 0);
      return;
    }
    // a connection the document's policy does not allow is refused before
    // anything is sent (WebTransport, "initialize WebTransport over HTTP",
    // and CSP's `connect-src`)
    if (
      !connectAllowed(this._seams.policies?.() ?? [], url, this._seams.origin())
    ) {
      const message = `Refused to connect to '${url}' because it violates the document's Content Security Policy directive "connect-src".`;
      this._seams.log?.('error', message);
      setTimeout(() => fail(message), 0);
      return;
    }
    const connector = this._seams.connector();
    if (!connector) {
      setTimeout(() => fail(`${url} was not opened: there is no network.`), 0);
      return;
    }
    const headers = Array.isArray(raw.headers)
      ? (raw.headers as unknown[])
          .filter(
            (h): h is [string, string] =>
              Array.isArray(h) &&
              h.length === 2 &&
              !FORBIDDEN.test(String(h[0])),
          )
          .map(
            ([k, v]) =>
              [String(k).toLowerCase(), String(v)] as [string, string],
          )
      : [];
    const hashes = Array.isArray(raw.serverCertificateHashes)
      ? (
          raw.serverCertificateHashes as {
            algorithm: unknown;
            value: unknown;
          }[]
        ).map((h) => ({
          algorithm: String(h.algorithm),
          value: bytesOf(String(h.value)),
        }))
      : [];
    const congestion = String(raw.congestionControl);
    const anticipated = (v: unknown): number | null =>
      typeof v === 'number' ? v : null;
    let session: WebTransportSessionLike;
    try {
      session = connector.connect(
        {
          url,
          origin: this._seams.origin(),
          headers,
          protocols: Array.isArray(raw.protocols)
            ? (raw.protocols as unknown[]).map(String)
            : [],
          serverCertificateHashes: hashes,
          allowPooling: raw.allowPooling === true,
          requireUnreliable: raw.requireUnreliable === true,
          congestionControl:
            congestion === 'throughput' || congestion === 'low-latency'
              ? congestion
              : 'default',
          anticipatedConcurrentIncomingUnidirectionalStreams: anticipated(
            raw.anticipatedConcurrentIncomingUnidirectionalStreams,
          ),
          anticipatedConcurrentIncomingBidirectionalStreams: anticipated(
            raw.anticipatedConcurrentIncomingBidirectionalStreams,
          ),
        },
        {
          ready: (info) => {
            if (s.state !== 'connecting') return;
            s.state = 'connected';
            this._wake(s);
            this._tell('__wtReady', [
              id,
              {
                protocol: String(info.protocol ?? ''),
                reliability:
                  info.reliability === 'reliable-only'
                    ? 'reliable-only'
                    : 'supports-unreliable',
                congestionControl: String(info.congestionControl ?? 'default'),
                responseHeaders: Array.isArray(info.responseHeaders)
                  ? info.responseHeaders.map(([k, v]) => [String(k), String(v)])
                  : null,
              },
            ]);
          },
          failed: (message) => {
            void this._snapshot(s).finally(() => fail(String(message)));
          },
          draining: () => {
            if (s.state !== 'connected') return;
            this._tell('__wtDraining', [id]);
          },
          closed: (closeCode, reason) => {
            if (s.state !== 'connected' && s.state !== 'connecting') return;
            void this._snapshot(s).finally(() => {
              if (s.state !== 'connected' && s.state !== 'connecting') return;
              s.state = 'closed';
              this._wake(s);
              this._tell('__wtClosed', [
                id,
                Number(closeCode) >>> 0,
                String(reason ?? ''),
              ]);
            });
          },
          datagram: (bytes) => {
            if (s.state !== 'connected') return;
            this._tell('__wtDatagram', [id, base64Of(bytes)]);
          },
          stream: (stream, bidirectional) => {
            if (s.state !== 'connected') return;
            const sid = this._adopt(s, stream);
            this._tell('__wtIncoming', [id, sid, bidirectional]);
          },
        },
      );
    } catch (error) {
      setTimeout(() => fail(String((error as Error)?.message ?? error)), 0);
      return;
    }
    s.session = session;
  }

  /** What waits for a session to be established is let go once it is, or
   *  once it never will be. */
  private _wake(s: Session): void {
    const waiting = s.waiting;
    s.waiting = [];
    for (const go of waiting) go();
  }

  /** Once the session is past being established. */
  private _settled(s: Session): Promise<void> {
    if (s.state !== 'connecting') return Promise.resolve();
    return new Promise((resolve) => s.waiting.push(resolve));
  }

  /** The connection's figures kept as it closes, for a page that asks
   *  after it has. */
  private async _snapshot(s: Session): Promise<void> {
    if (s.state !== 'connected' || !s.session) return;
    try {
      s.stats = await s.session.stats();
    } catch {}
  }

  private _closeSession(s: Session, code: number, reason: string): void {
    if (s.state === 'closed' || s.state === 'failed') return;
    const session = s.session;
    const wasConnected = s.state === 'connected';
    const close = (): void => {
      try {
        session?.close(code, reason);
      } catch {}
    };
    s.state = 'closed';
    this._wake(s);
    if (wasConnected && session) {
      // its figures as it was when the page closed it
      session.stats().then(
        (stats) => {
          s.stats = stats;
        },
        () => {},
      );
    }
    close();
  }

  private _adopt(s: Session, stream: WebTransportStreamLike): number {
    const id = ++this._streamSeq;
    const st: Stream = { id, session: s, stream, reading: true };
    this._streams.set(id, st);
    s.streams.add(id);
    stream.listen({
      readable: () => {
        if (st.reading && this._streams.has(id)) {
          this._tell('__wtReadable', [id]);
        }
      },
      end: () => {
        if (st.reading && this._streams.has(id)) this._tell('__wtEnd', [id]);
      },
      reset: (code) => {
        if (!this._streams.has(id)) return;
        st.reading = false;
        this._tell('__wtReset', [id, code]);
      },
      stopSending: (code) => {
        if (this._streams.has(id)) this._tell('__wtStopSending', [id, code]);
      },
    });
    return id;
  }

  private _create(sessionId: number, request: number, json: string): void {
    const s = this._sessions.get(sessionId);
    const answer = (id: number | null, error: string | null): void =>
      this._tell('__wtCreated', [request, id, error]);
    if (!s) {
      answer(null, 'InvalidStateError');
      return;
    }
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(json) as Record<string, unknown>;
    } catch {}
    void this._settled(s).then(() => {
      if (s.state !== 'connected' || !s.session) {
        answer(null, 'InvalidStateError');
        return;
      }
      s.session
        .createStream(raw.bidirectional === true, {
          ...priorityOf(raw),
          waitUntilAvailable: raw.waitUntilAvailable === true,
        })
        .then(
          (stream) => {
            if (s.state !== 'connected') {
              try {
                stream.reset(0);
              } catch {}
              answer(null, 'InvalidStateError');
              return;
            }
            answer(this._adopt(s, stream), null);
          },
          // a stream the session could not open, gone or refused, is
          // the page's InvalidStateError
          () => answer(null, 'InvalidStateError'),
        );
    });
  }

  private _write(id: number, request: number, base64: string): void {
    const st = this._streams.get(id);
    const answer = (error: string | null): void =>
      this._tell('__wtWritten', [id, request, error]);
    if (!st) {
      answer('The stream is gone.');
      return;
    }
    st.stream.write(bytesOf(base64)).then(
      () => answer(null),
      (error: unknown) => answer(String((error as Error)?.message ?? error)),
    );
  }

  private _finish(id: number, request: number): void {
    const st = this._streams.get(id);
    const answer = (error: string | null): void =>
      this._tell('__wtWritten', [id, request, error]);
    if (!st) {
      answer('The stream is gone.');
      return;
    }
    st.stream.finish().then(
      () => answer(null),
      (error: unknown) => answer(String((error as Error)?.message ?? error)),
    );
  }

  private _stats(sessionId: number, request: number): void {
    const s = this._sessions.get(sessionId);
    const answer = (stats: unknown, error: string | null): void =>
      this._tell('__wtStats', [request, stats, error]);
    if (!s) {
      answer(null, 'InvalidStateError');
      return;
    }
    void this._settled(s).then(() => {
      if (s.state === 'failed') {
        answer(null, 'InvalidStateError');
        return;
      }
      if (s.state === 'connected' && s.session) {
        s.session.stats().then(
          (stats) => {
            s.stats = stats;
            answer(stats, null);
          },
          () => answer(s.stats ?? {}, null),
        );
        return;
      }
      answer(s.stats ?? {}, null);
    });
  }

  private _streamStats(id: number, request: number): void {
    const st = this._streams.get(id);
    const answer = (stats: unknown): void =>
      this._tell('__wtStats', [request, stats, null]);
    if (!st) {
      answer({});
      return;
    }
    st.stream.stats().then(answer, () => answer({}));
  }

  private _groupStats(sessionId: number, group: number, request: number) {
    const s = this._sessions.get(sessionId);
    const answer = (stats: unknown): void =>
      this._tell('__wtStats', [request, stats, null]);
    if (!s?.session) {
      answer({});
      return;
    }
    s.session.groupStats(group).then(answer, () => answer({}));
  }
}

/** A stream's or a datagram's place in the session's turns, from what the
 *  page set. */
function priorityOf(raw: unknown): WebTransportPriority {
  let o: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw) as Record<string, unknown>;
    } catch {}
  } else if (raw && typeof raw === 'object') {
    o = raw as Record<string, unknown>;
  }
  const order = Number(o.sendOrder);
  const group = Number(o.sendGroup);
  return {
    sendOrder: Number.isFinite(order) ? order : 0,
    sendGroup: Number.isFinite(group) && group > 0 ? group : null,
  };
}
