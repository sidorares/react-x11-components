// A worker's WebTransport sessions, carried across its thread to the page
// process's seam (`HtmlScripts.webTransport`), as its `fetch` is: the
// browser's network policy is the page process's, and an `HtmlWebTransport`
// is an object of the host's — functions, a QUIC stack — that no thread can
// be handed.
//
// The thread's host is given a `TransportProxy` for its seam, which answers
// as a seam does and posts what it is asked to the page process, where a
// `TransportRelay` for the worker drives the page's own seam and posts
// what becomes of each session and stream back. What crosses is plain data
// — numbers, strings, a `Uint8Array` copied — over the thread's one channel,
// tagged `{ kind: 'wt' }`.
//
// The seam's few answers that are not events are answered on the worker's
// side from what it has: `maxDatagramSize()` from the last size the page
// process told, `sendDatagram()` as sent where it fits it, and a send
// group's number made here and mapped there. What settles later — a
// stream made, stats, keying material — is asked by a request number and
// answered by it, a rejection by its name, which is what the worker's host
// makes the page's error of. A stream's bytes are pulled
// across as they are on the page's side: the worker asks for more
// (`want`) as the page realm reads, and the page process reads the real
// stream only then, so a worker that reads nothing holds the peer back too.
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
} from '../transport.js';
import { NO_WEBTRANSPORT, exportFrom } from '../transport.js';
import type { SetTimeout } from './platform.js';

declare const setTimeout: SetTimeout;

/** What a worker's thread asks of the page process. */
export type TransportAsk =
  | {
      kind: 'wt';
      op: 'connect';
      s: number;
      request: WebTransportConnectRequest;
    }
  | { kind: 'wt'; op: 'close'; s: number; code: number; reason: string }
  | {
      kind: 'wt';
      op: 'datagram';
      s: number;
      bytes: Uint8Array;
      priority: WebTransportPriority;
    }
  | { kind: 'wt'; op: 'group'; s: number; g: number }
  | { kind: 'wt'; op: 'groupStats'; s: number; g: number; req: number }
  | { kind: 'wt'; op: 'stats'; s: number; req: number }
  | {
      kind: 'wt';
      op: 'export';
      s: number;
      req: number;
      label: Uint8Array;
      context: Uint8Array;
      length: number;
    }
  | {
      kind: 'wt';
      op: 'create';
      s: number;
      req: number;
      bidirectional: boolean;
      options: WebTransportPriority & { waitUntilAvailable: boolean };
    }
  | { kind: 'wt'; op: 'want'; st: number }
  | { kind: 'wt'; op: 'write'; st: number; req: number; bytes: Uint8Array }
  | { kind: 'wt'; op: 'finish'; st: number; req: number }
  | { kind: 'wt'; op: 'reset'; st: number; code: number }
  | { kind: 'wt'; op: 'stop'; st: number; code: number }
  | { kind: 'wt'; op: 'priority'; st: number; priority: WebTransportPriority }
  | { kind: 'wt'; op: 'streamStats'; st: number; req: number };

/** What the page process tells a worker's thread. */
export type TransportTell =
  | {
      kind: 'wt';
      ev: 'ready';
      s: number;
      info: Parameters<WebTransportSessionEvents['ready']>[0];
      max: number;
    }
  | { kind: 'wt'; ev: 'failed'; s: number; message: string }
  | { kind: 'wt'; ev: 'closed'; s: number; code: number; reason: string }
  | { kind: 'wt'; ev: 'draining'; s: number }
  | { kind: 'wt'; ev: 'datagram'; s: number; bytes: Uint8Array; max: number }
  | { kind: 'wt'; ev: 'max'; s: number; max: number }
  | { kind: 'wt'; ev: 'stream'; s: number; st: number; bidirectional: boolean }
  | { kind: 'wt'; ev: 'created'; req: number; st: number | null }
  | { kind: 'wt'; ev: 'data'; st: number; bytes: Uint8Array }
  | { kind: 'wt'; ev: 'end'; st: number }
  | { kind: 'wt'; ev: 'reset'; st: number; code: number | null }
  | { kind: 'wt'; ev: 'stopSending'; st: number; code: number | null }
  | { kind: 'wt'; ev: 'written'; req: number; error: string | null }
  | { kind: 'wt'; ev: 'stats'; req: number; stats: unknown }
  | {
      kind: 'wt';
      ev: 'exported';
      req: number;
      bytes: Uint8Array | null;
      /** The rejection's name and message, where it rejected. */
      error: { name: string; message: string } | null;
    };

// --- the worker's side ------------------------------------------------------

/** A stream of the page process's, as the worker's host reads it. */
class ProxyStream implements WebTransportStreamLike {
  private _events: WebTransportStreamEvents | null = null;
  private _early: ((e: WebTransportStreamEvents) => void)[] = [];
  private _buffer: Uint8Array[] = [];
  private _wanted = false;
  private _ended = false;
  private _endTold = false;

  constructor(
    readonly id: number,
    private readonly _proxy: TransportProxy,
  ) {}

  /** What the page process told of it. */
  heard(m: TransportTell): void {
    if (m.ev === 'data') {
      this._wanted = false;
      this._buffer.push(m.bytes);
      this._tell((e) => e.readable());
    } else if (m.ev === 'end') {
      this._wanted = false;
      this._ended = true;
      if (!this._buffer.length) this._end();
      else this._tell((e) => e.readable());
    } else if (m.ev === 'reset') {
      this._buffer = [];
      this._tell((e) => e.reset(m.code));
    } else if (m.ev === 'stopSending') {
      this._tell((e) => e.stopSending(m.code));
    }
  }

  private _tell(fn: (e: WebTransportStreamEvents) => void): void {
    if (this._events) fn(this._events);
    else this._early.push(fn);
  }
  private _end(): void {
    if (this._endTold) return;
    this._endTold = true;
    this._tell((e) => e.end());
  }

  listen(events: WebTransportStreamEvents): void {
    this._events = events;
    for (const fn of this._early.splice(0)) fn(events);
  }
  read(): Uint8Array | null {
    const chunks = this._buffer;
    this._buffer = [];
    if (!chunks.length) {
      if (this._ended) setTimeout(() => this._end(), 0);
      else if (!this._wanted) {
        this._wanted = true;
        this._proxy.ask({ kind: 'wt', op: 'want', st: this.id });
      }
      return null;
    }
    if (chunks.length === 1) return chunks[0];
    let size = 0;
    for (const c of chunks) size += c.byteLength;
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
  write(bytes: Uint8Array): Promise<void> {
    return this._proxy
      .request((req) => ({ kind: 'wt', op: 'write', st: this.id, req, bytes }))
      .then((m) => {
        if (m.ev === 'written' && m.error !== null) throw new Error(m.error);
      });
  }
  finish(): Promise<void> {
    return this._proxy
      .request((req) => ({ kind: 'wt', op: 'finish', st: this.id, req }))
      .then((m) => {
        if (m.ev === 'written' && m.error !== null) throw new Error(m.error);
      });
  }
  reset(code: number): void {
    this._proxy.ask({ kind: 'wt', op: 'reset', st: this.id, code });
  }
  stopSending(code: number): void {
    this._proxy.ask({ kind: 'wt', op: 'stop', st: this.id, code });
  }
  prioritize(priority: WebTransportPriority): void {
    this._proxy.ask({ kind: 'wt', op: 'priority', st: this.id, priority });
  }
  stats(): Promise<WebTransportStreamStats> {
    return this._proxy
      .request((req) => ({ kind: 'wt', op: 'streamStats', st: this.id, req }))
      .then((m) =>
        m.ev === 'stats' ? (m.stats as WebTransportStreamStats) : {},
      );
  }
}

/** A session of the page process's, as the worker's host has it. */
interface ProxySession {
  events: WebTransportSessionEvents;
  max: number;
  groups: number;
}

/**
 * The seam a worker's host is given (`worker-thread.ts`): each session it
 * is asked for opened by the page process, through `ask`, and what the
 * page process tells handed to `heard`.
 */
export class TransportProxy implements HtmlWebTransport {
  private _sessions = new Map<number, ProxySession>();
  private _streams = new Map<number, ProxyStream>();
  private _waiting = new Map<number, (m: TransportTell) => void>();
  private _sessionSeq = 0;
  private _requestSeq = 0;

  constructor(private readonly _post: (m: TransportAsk) => void) {}

  ask(m: TransportAsk): void {
    this._post(m);
  }
  /** An ask answered by request number. */
  request(make: (req: number) => TransportAsk): Promise<TransportTell> {
    const req = ++this._requestSeq;
    return new Promise((resolve) => {
      this._waiting.set(req, resolve);
      this._post(make(req));
    });
  }

  connect(
    request: WebTransportConnectRequest,
    events: WebTransportSessionEvents,
  ): WebTransportSessionLike {
    const s = ++this._sessionSeq;
    const session: ProxySession = { events, max: 0, groups: 0 };
    this._sessions.set(s, session);
    this._post({ kind: 'wt', op: 'connect', s, request });
    return {
      createStream: (bidirectional, options) =>
        this.request((req) => ({
          kind: 'wt',
          op: 'create',
          s,
          req,
          bidirectional,
          options,
        })).then((m) => {
          if (m.ev !== 'created' || m.st === null) {
            throw new Error('The stream could not be opened.');
          }
          return this._stream(m.st);
        }),
      sendDatagram: (bytes, priority) => {
        if (bytes.byteLength > session.max) return false;
        this._post({ kind: 'wt', op: 'datagram', s, bytes, priority });
        return true;
      },
      maxDatagramSize: () => session.max,
      createSendGroup: () => {
        const g = ++session.groups;
        this._post({ kind: 'wt', op: 'group', s, g });
        return g;
      },
      groupStats: (g) =>
        this.request((req) => ({
          kind: 'wt',
          op: 'groupStats',
          s,
          g,
          req,
        })).then((m) =>
          m.ev === 'stats' ? (m.stats as WebTransportStreamStats) : {},
        ),
      stats: () =>
        this.request((req) => ({ kind: 'wt', op: 'stats', s, req })).then(
          (m) => (m.ev === 'stats' ? (m.stats as WebTransportStats) : {}),
        ),
      exportKeyingMaterial: (label, context, length) =>
        this.request((req) => ({
          kind: 'wt',
          op: 'export',
          s,
          req,
          label,
          context,
          length,
        })).then((m) => {
          if (m.ev === 'exported' && m.bytes) return m.bytes;
          const error = new Error(
            m.ev === 'exported' && m.error
              ? m.error.message
              : 'The session is gone.',
          );
          if (m.ev === 'exported' && m.error) error.name = m.error.name;
          throw error;
        }),
      close: (code, reason) => {
        this._post({ kind: 'wt', op: 'close', s, code, reason });
        this._sessions.delete(s);
      },
    };
  }

  private _stream(id: number): ProxyStream {
    let stream = this._streams.get(id);
    if (!stream) this._streams.set(id, (stream = new ProxyStream(id, this)));
    return stream;
  }

  /** What the page process told. */
  heard(m: TransportTell): void {
    if ('req' in m) {
      const answer = this._waiting.get(m.req);
      this._waiting.delete(m.req);
      answer?.(m);
      return;
    }
    if ('st' in m && m.ev !== 'stream') {
      this._streams.get(m.st)?.heard(m);
      return;
    }
    const session = this._sessions.get(m.s);
    if (!session) return;
    const e = session.events;
    switch (m.ev) {
      case 'ready':
        session.max = m.max;
        e.ready(m.info);
        return;
      case 'failed':
        this._sessions.delete(m.s);
        e.failed(m.message);
        return;
      case 'closed':
        this._sessions.delete(m.s);
        e.closed(m.code, m.reason);
        return;
      case 'draining':
        e.draining();
        return;
      case 'max':
        session.max = m.max;
        return;
      case 'datagram':
        session.max = m.max;
        e.datagram(m.bytes);
        return;
      case 'stream':
        e.stream(this._stream(m.st), m.bidirectional);
        return;
    }
  }
}

// --- the page process's side --------------------------------------------------

interface RelayedSession {
  session: WebTransportSessionLike;
  /** The worker's send group numbers, the seam's by them. */
  groups: Map<number, number>;
}

interface RelayedStream {
  stream: WebTransportStreamLike;
  /** Its session, whose send groups its priority names. */
  session: RelayedSession;
  /** Whether the worker waits for bytes. */
  wanted: boolean;
}

/**
 * A worker's sessions on the page process's side (`workers.ts`): what its
 * thread asks driven over the page's own seam, and what becomes of each
 * session and stream posted back.
 */
export class TransportRelay {
  private _sessions = new Map<number, RelayedSession>();
  private _streams = new Map<number, RelayedStream>();
  private _streamSeq = 0;
  private _disposed = false;

  constructor(
    private readonly _connector: () => HtmlWebTransport | undefined,
    private readonly _post: (m: TransportTell) => void,
  ) {}

  /** Whether a session of the worker's is still open, or opening: what
   *  keeps its page out of the back-forward cache. */
  get open(): boolean {
    return this._sessions.size > 0;
  }

  private _tell(m: TransportTell): void {
    if (!this._disposed) this._post(m);
  }

  /** The worker ended: its sessions go with it. */
  dispose(): void {
    this._disposed = true;
    for (const { session } of this._sessions.values()) {
      try {
        session.close(0, '');
      } catch {}
    }
    this._sessions.clear();
    this._streams.clear();
  }

  private _group(s: RelayedSession, g: number | null): number | null {
    return g === null ? null : (s.groups.get(g) ?? null);
  }
  private _priority(
    s: RelayedSession,
    p: WebTransportPriority,
  ): WebTransportPriority {
    return { sendOrder: p.sendOrder, sendGroup: this._group(s, p.sendGroup) };
  }

  private _adopt(
    stream: WebTransportStreamLike,
    session: RelayedSession,
  ): number {
    const st = ++this._streamSeq;
    const r: RelayedStream = { stream, session, wanted: false };
    this._streams.set(st, r);
    stream.listen({
      readable: () => {
        if (r.wanted) this._give(st, r);
      },
      end: () => this._tell({ kind: 'wt', ev: 'end', st }),
      reset: (code) => this._tell({ kind: 'wt', ev: 'reset', st, code }),
      stopSending: (code) =>
        this._tell({ kind: 'wt', ev: 'stopSending', st, code }),
    });
    return st;
  }
  /** The bytes the worker asked for, where there are any yet. */
  private _give(st: number, r: RelayedStream): void {
    const bytes = r.stream.read();
    if (!bytes) {
      r.wanted = true;
      return;
    }
    r.wanted = false;
    this._tell({ kind: 'wt', ev: 'data', st, bytes });
  }

  /** What the worker's thread asked. */
  heard(m: TransportAsk): void {
    if (this._disposed) return;
    if (m.op === 'connect') {
      this._connect(m.s, m.request);
      return;
    }
    if ('st' in m) {
      const r = this._streams.get(m.st);
      if (!r) {
        if ('req' in m) {
          this._tell(
            m.op === 'streamStats'
              ? { kind: 'wt', ev: 'stats', req: m.req, stats: {} }
              : {
                  kind: 'wt',
                  ev: 'written',
                  req: m.req,
                  error: 'The stream is gone.',
                },
          );
        }
        return;
      }
      switch (m.op) {
        case 'want':
          this._give(m.st, r);
          return;
        case 'write':
        case 'finish': {
          const done =
            m.op === 'write' ? r.stream.write(m.bytes) : r.stream.finish();
          const req = m.req;
          done.then(
            () => this._tell({ kind: 'wt', ev: 'written', req, error: null }),
            (error: unknown) =>
              this._tell({
                kind: 'wt',
                ev: 'written',
                req,
                error: String((error as Error)?.message ?? error),
              }),
          );
          return;
        }
        case 'reset':
          r.stream.reset(m.code);
          return;
        case 'stop':
          r.stream.stopSending(m.code);
          return;
        case 'priority':
          r.stream.prioritize(this._priority(r.session, m.priority));
          return;
        case 'streamStats': {
          const req = m.req;
          r.stream.stats().then(
            (stats) => this._tell({ kind: 'wt', ev: 'stats', req, stats }),
            () => this._tell({ kind: 'wt', ev: 'stats', req, stats: {} }),
          );
          return;
        }
      }
      return;
    }
    const s = this._sessions.get(m.s);
    if (!s) {
      if (m.op === 'create') {
        this._tell({ kind: 'wt', ev: 'created', req: m.req, st: null });
      } else if (m.op === 'stats' || m.op === 'groupStats') {
        this._tell({ kind: 'wt', ev: 'stats', req: m.req, stats: {} });
      } else if (m.op === 'export') {
        this._tell({
          kind: 'wt',
          ev: 'exported',
          req: m.req,
          bytes: null,
          error: { name: 'InvalidStateError', message: 'The session is gone.' },
        });
      }
      return;
    }
    switch (m.op) {
      case 'close':
        this._sessions.delete(m.s);
        s.session.close(m.code, m.reason);
        return;
      case 'datagram':
        s.session.sendDatagram(m.bytes, this._priority(s, m.priority));
        this._tell({
          kind: 'wt',
          ev: 'max',
          s: m.s,
          max: s.session.maxDatagramSize(),
        });
        return;
      case 'group':
        s.groups.set(m.g, s.session.createSendGroup());
        return;
      case 'groupStats': {
        const req = m.req;
        const g = this._group(s, m.g);
        (g === null ? Promise.resolve({}) : s.session.groupStats(g)).then(
          (stats) => this._tell({ kind: 'wt', ev: 'stats', req, stats }),
          () => this._tell({ kind: 'wt', ev: 'stats', req, stats: {} }),
        );
        return;
      }
      case 'stats': {
        const req = m.req;
        s.session.stats().then(
          (stats) => this._tell({ kind: 'wt', ev: 'stats', req, stats }),
          () => this._tell({ kind: 'wt', ev: 'stats', req, stats: {} }),
        );
        return;
      }
      case 'export': {
        const req = m.req;
        exportFrom(s.session, m.label, m.context, m.length).then(
          (bytes) =>
            this._tell({ kind: 'wt', ev: 'exported', req, bytes, error: null }),
          (error: unknown) =>
            this._tell({
              kind: 'wt',
              ev: 'exported',
              req,
              bytes: null,
              error: {
                name: String((error as Error)?.name ?? 'Error'),
                message: String((error as Error)?.message ?? error),
              },
            }),
        );
        return;
      }
      case 'create': {
        const req = m.req;
        s.session
          .createStream(m.bidirectional, {
            ...this._priority(s, m.options),
            waitUntilAvailable: m.options.waitUntilAvailable,
          })
          .then(
            (stream) =>
              this._tell({
                kind: 'wt',
                ev: 'created',
                req,
                st: this._adopt(stream, s),
              }),
            () => this._tell({ kind: 'wt', ev: 'created', req, st: null }),
          );
        return;
      }
    }
  }

  private _connect(s: number, request: WebTransportConnectRequest): void {
    const connector = this._connector() ?? NO_WEBTRANSPORT;
    let relayed: RelayedSession | null = null;
    // a seam may fail a session while it is being asked for it
    let ended = false;
    const session = connector.connect(request, {
      ready: (info) =>
        this._tell({
          kind: 'wt',
          ev: 'ready',
          s,
          info,
          max: relayed ? relayed.session.maxDatagramSize() : 0,
        }),
      failed: (message) => {
        ended = true;
        this._sessions.delete(s);
        this._tell({ kind: 'wt', ev: 'failed', s, message });
      },
      closed: (code, reason) => {
        ended = true;
        this._sessions.delete(s);
        this._tell({ kind: 'wt', ev: 'closed', s, code, reason });
      },
      draining: () => this._tell({ kind: 'wt', ev: 'draining', s }),
      datagram: (bytes) =>
        this._tell({
          kind: 'wt',
          ev: 'datagram',
          s,
          bytes,
          max: relayed ? relayed.session.maxDatagramSize() : 0,
        }),
      stream: (stream, bidirectional) => {
        if (!relayed) return;
        this._tell({
          kind: 'wt',
          ev: 'stream',
          s,
          st: this._adopt(stream, relayed),
          bidirectional,
        });
      },
    });
    relayed = { session, groups: new Map() };
    if (!ended) this._sessions.set(s, relayed);
  }
}
