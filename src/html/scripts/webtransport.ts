// W3C WebTransport, as a page's scripts see it: `WebTransport` and its
// datagrams, its streams, its send groups and its errors, over the page
// realm's own WHATWG streams (`streams.ts`).
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` is handed it and calls it
// with what it reaches the host by.
//
// The network's half is the host's (`transports.ts`, over the
// `HtmlScripts.webTransport` seam): a session is a number, a stream is a
// number, and what crosses either way is primitives — bytes as base64.
// Everything a page holds — the promises, the streams, the errors, the
// stats — is made here, of the page's own classes, so what a refusal or a
// failure hands the page is the page realm's.

import type { StreamsInternals } from './streams.js';

/** What `installDom` hands this. */
export interface WebTransportDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  DOMException: unknown;
  Headers: unknown;
  URL: unknown;
  setTimer(fn: () => void, ms: number): unknown;
  streams: StreamsInternals;
  ReadableStream: unknown;
  WritableStream: unknown;
  WritableStreamDefaultWriter: unknown;
  bytesOfBase64(text: string): Uint8Array;
  base64OfBytes(bytes: Uint8Array): string;
}

export function installWebTransport(
  deps: WebTransportDeps,
): Record<string, unknown> {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const call: Any = D.call;
  const entry: Any = D.entry;
  const input: Any = D.input;
  const DOMException: Any = D.DOMException;
  const Headers: Any = D.Headers;
  const URLClass: Any = D.URL;
  const setTimer: Any = D.setTimer;
  const S: Any = D.streams;
  const ReadableStream: Any = D.ReadableStream;
  const WritableStream: Any = D.WritableStream;
  const WritableStreamDefaultWriter: Any = D.WritableStreamDefaultWriter;
  const bytesOfBase64: Any = D.bytesOfBase64;
  const base64OfBytes: Any = D.base64OfBytes;

  const P: Any = Promise;
  const pThen: Any = P.prototype.then;
  const apply: Any = Reflect.apply;
  const WM: Any = WeakMap;
  const wmGet: Any = WM.prototype.get;
  const wmSet: Any = WM.prototype.set;
  const objectCreate = Object.create;
  const isView: Any = ArrayBuffer.isView;
  const abSlice: Any = ArrayBuffer.prototype.slice;
  const abByteLength: Any = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
  )!.get;
  const U8: Any = Uint8Array;
  const now = (): number => Date.now();

  const noop = (): void => {};
  const typeError = (message: string): Any => new TypeError(message);
  const rangeError = (message: string): Any => new RangeError(message);
  const domError = (message: string, name: string): Any =>
    new DOMException(message, name);
  const illegal = (): Any => typeError('Illegal invocation');
  const illegalConstructor = (): Any => typeError('Illegal constructor');
  const isObject = (v: Any): boolean =>
    (typeof v === 'object' && v !== null) || typeof v === 'function';

  // --- promises and slots ---------------------------------------------------

  interface Deferred {
    promise: Promise<Any>;
    state: 0 | 1 | 2;
    resolve(v?: Any): void;
    reject(e: Any): void;
  }
  const deferred = (): Deferred => {
    let res!: (v: Any) => void;
    let rej!: (e: Any) => void;
    const promise = new P((a: Any, b: Any) => {
      res = a;
      rej = b;
    });
    const d: Deferred = {
      promise,
      state: 0,
      resolve(v?: Any) {
        if (d.state) return;
        d.state = 1;
        res(v);
      },
      reject(e: Any) {
        if (d.state) return;
        d.state = 2;
        rej(e);
      },
    };
    return d;
  };
  const resolvedWith = (v?: Any): Promise<Any> => new P((r: Any) => r(v));
  const rejectedWith = (e: Any): Promise<Any> =>
    new P((_: Any, r: Any) => r(e));
  const markHandled = (p: Promise<Any>): void => {
    apply(pThen, p, [undefined, noop]);
  };

  const TOKEN = Object.freeze(objectCreate(null));
  const SLOTS = new WM();
  const own = (x: Any, record: Any): void => {
    apply(wmSet, SLOTS, [x, record]);
  };
  const slotOf = (x: Any): Any =>
    isObject(x) ? apply(wmGet, SLOTS, [x]) : undefined;
  const brand = (x: Any, tag: string): Any => {
    const r = slotOf(x);
    if (!r || r.tag !== tag) throw illegal();
    return r;
  };

  // --- Web IDL's conversions -----------------------------------------------

  const dictionary = (v: Any, name: string): Any => {
    if (v === undefined || v === null) return null;
    if (!isObject(v)) {
      throw typeError(`The provided value is not of type '${name}'.`);
    }
    return v;
  };
  /** A `USVString`: lone surrogates made U+FFFD. */
  const usv = (v: Any): string => {
    const s = `${v}`;
    return typeof (s as Any).toWellFormed === 'function'
      ? (s as Any).toWellFormed()
      : s;
  };
  /** `[EnforceRange]` over an integer type's range. */
  const enforceRange = (v: Any, max: number, context: string): number => {
    const x = +v;
    if (!Number.isFinite(x)) {
      throw typeError(`${context}: Value is not a finite number.`);
    }
    const t = Math.trunc(x);
    if (t < 0 || t > max) {
      throw typeError(`${context}: Value is outside the '${max === 65535 ? 'unsigned short' : 'unsigned long'}' value range.`);
    }
    return t === 0 ? 0 : t;
  };
  /** `unsigned long`, as Web IDL converts one with no annotation. */
  const unsignedLong = (v: Any): number => {
    const x = +v;
    if (!Number.isFinite(x)) return 0;
    const t = Math.trunc(x);
    return ((t % 4294967296) + 4294967296) % 4294967296;
  };
  /** `[Clamp] unsigned long`. */
  const clampLong = (v: Any): number => {
    const x = +v;
    if (Number.isNaN(x)) return 0;
    const c = Math.min(Math.max(x, 0), 4294967295);
    const f = Math.floor(c);
    // half to even, as Web IDL rounds a clamped value
    const r = c - f > 0.5 || (c - f === 0.5 && f % 2 === 1) ? f + 1 : f;
    return r;
  };
  /** `long long`, as Web IDL converts one with no annotation. */
  const longLong = (v: Any): number => {
    const x = +v;
    if (!Number.isFinite(x)) return 0;
    const t = Math.trunc(x);
    return t === 0 ? 0 : t;
  };
  const sequence = (v: Any, context: string): Any[] => {
    if (!isObject(v)) {
      throw typeError(`${context}: The provided value cannot be converted to a sequence.`);
    }
    const method = v[Symbol.iterator];
    if (typeof method !== 'function') {
      throw typeError(`${context}: The object must have a callable @@iterator property.`);
    }
    const out: Any[] = [];
    const it = apply(method, v, []);
    for (;;) {
      const r = it.next();
      if (!isObject(r)) throw typeError(`${context}: The iterator result is not an object.`);
      if (r.done) break;
      out[out.length] = r.value;
    }
    return out;
  };
  /** A `BufferSource`'s bytes, copied, or null where it is none. */
  const bufferBytes = (v: Any): Uint8Array | null => {
    if (!isObject(v)) return null;
    if (isView(v)) {
      try {
        apply(abByteLength, v.buffer, []);
      } catch {
        return null; // over a shared buffer
      }
      return new U8(apply(abSlice, v.buffer, [v.byteOffset, v.byteOffset + v.byteLength]));
    }
    try {
      apply(abByteLength, v, []);
    } catch {
      return null;
    }
    return new U8(apply(abSlice, v, [0]));
  };

  /** A protocol a page may offer: a structured-field string's characters,
   *  printable ASCII, 1 to 512 of them (WebTransport over HTTP/3,
   *  WT-Available-Protocols). */
  const validProtocol = (p: string): boolean =>
    p.length > 0 && p.length <= 512 && /^[\x20-\x7e]+$/.test(p);

  /** The longest prefix of a reason whose UTF-8 is 1024 bytes or fewer, as
   *  `close()` sends it (WebTransport, `close`). */
  const truncatedReason = (reason: string): string => {
    let bytes = 0;
    let end = 0;
    for (const ch of reason) {
      const code = ch.codePointAt(0)!;
      const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      if (bytes + size > 1024) break;
      bytes += size;
      end += ch.length;
    }
    return reason.slice(0, end);
  };

  // --- errors -----------------------------------------------------------------

  class WebTransportError extends DOMException {
    constructor(message: Any = '', options: Any = undefined) {
      // the form Chrome's has, one dictionary with the message in it
      // (`WebTransportErrorInit`), which pages and WPT write: an object
      // where the message would be is taken for it
      if (isObject(message) && options === undefined) {
        options = message;
        message = message.message === undefined ? '' : message.message;
      }
      const text = `${message}`;
      const d = dictionary(options, 'WebTransportErrorOptions');
      let source = 'stream';
      let streamErrorCode: number | null = null;
      if (d) {
        const rawSource = d.source;
        if (rawSource !== undefined) {
          source = `${rawSource}`;
          if (source !== 'stream' && source !== 'session') {
            throw typeError(`Failed to construct 'WebTransportError': The provided value '${source}' is not a valid enum value of type WebTransportErrorSource.`);
          }
        }
        const rawCode = d.streamErrorCode;
        if (rawCode !== undefined && rawCode !== null) {
          streamErrorCode = clampLong(rawCode);
        }
      }
      super(text, 'WebTransportError');
      own(this, { tag: 'WTE', source, streamErrorCode });
    }
    get source(): string {
      return brand(this, 'WTE').source;
    }
    get streamErrorCode(): number | null {
      return brand(this, 'WTE').streamErrorCode;
    }
  }
  const sessionError = (message: string): Any =>
    new WebTransportError(message, { source: 'session' });
  const streamError = (message: string, code: number | null): Any =>
    new WebTransportError(message, {
      source: 'stream',
      streamErrorCode: code,
    });
  /** The code a reason a page cancels or aborts a stream with carries: a
   *  `WebTransportError`'s, else 0. */
  const codeOf = (reason: Any): number => {
    const r = slotOf(reason);
    return r && r.tag === 'WTE' && r.streamErrorCode !== null
      ? r.streamErrorCode
      : 0;
  };

  // --- sessions by their number, and their streams ---------------------------

  let sessionSeq = 0;
  let requestSeq = 0;
  const sessions = new Map<number, Any>();
  const streamsById = new Map<number, Any>();
  /** Stream creations under way, by request: settled by `__wtCreated`. */
  const creating = new Map<number, Any>();
  /** Writes and finishes under way, by request: settled by `__wtWritten`. */
  const writing = new Map<number, Deferred>();
  /** Stats asked for, by request: settled by `__wtStats`. */
  const statsAsked = new Map<number, Any>();

  /** A stream's sides, each over when it ends: once both are, the host
   *  forgets it. */
  const sideOver = (rec: Any, side: 'send' | 'receive'): void => {
    rec[side] = false;
    if (!rec.send && !rec.receive && streamsById.get(rec.sid) === rec) {
      streamsById.delete(rec.sid);
      call('wtForget', rec.sid);
    }
  };

  // --- send streams -----------------------------------------------------------

  class WebTransportSendStream extends WritableStream {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
      super(S.INTERNAL);
    }
    get sendGroup(): Any {
      const r = brand(this, 'WTSS');
      return r.sendGroup ? r.sendGroup.obj : null;
    }
    set sendGroup(group: Any) {
      const r = brand(this, 'WTSS');
      const g = groupArgument(r.stream.t, group);
      r.sendGroup = g;
      prioritize(r);
    }
    get sendOrder(): number {
      return brand(this, 'WTSS').sendOrder;
    }
    set sendOrder(order: Any) {
      const r = brand(this, 'WTSS');
      r.sendOrder = longLong(order);
      prioritize(r);
    }
    getStats(): Promise<Any> {
      const r = slotOf(this);
      if (!r || r.tag !== 'WTSS') return rejectedWith(illegal());
      return askStats(r.stream.t, 'wtStreamStats', r.stream.sid, (s: Any) => ({
        bytesWritten: s.bytesWritten ?? 0,
        bytesSent: s.bytesSent ?? 0,
        bytesAcknowledged: s.bytesAcknowledged ?? 0,
      }));
    }
    getWriter(): Any {
      brand(this, 'WTSS');
      return new WebTransportWriter(TOKEN, this);
    }
  }
  const prioritize = (r: Any): void => {
    const rec = r.stream;
    if (!rec.send) return;
    call(
      'wtPriority',
      rec.sid,
      JSON.stringify({
        sendOrder: r.sendOrder,
        sendGroup: r.sendGroup ? r.sendGroup.number : null,
      }),
    );
  };

  class WebTransportWriter extends WritableStreamDefaultWriter {
    constructor(token: Any = undefined, stream: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
      super(stream);
      own(this, { tag: 'WTW' });
    }
    atomicWrite(chunk: Any = undefined): Promise<Any> {
      // an atomic write is one the stream takes whole: every write here is
      if (!slotOf(this)) return rejectedWith(illegal());
      return this.write(chunk);
    }
    commit(): void {
      brand(this, 'WTW');
    }
  }

  /** A send stream over a stream of the host's. */
  const makeSendStream = (rec: Any, priority: Any): Any => {
    const obj = new WebTransportSendStream(TOKEN);
    const r = {
      tag: 'WTSS',
      obj,
      stream: rec,
      sendOrder: priority.sendOrder,
      sendGroup: priority.sendGroup,
    };
    own(obj, r);
    rec.sendObj = obj;
    rec.sendRec = r;
    const ws = S.writable(
      () => undefined,
      (chunk: Any) => {
        const bytes = bufferBytes(chunk);
        if (bytes === null) {
          return rejectedWith(typeError("Failed to execute 'write' on 'WebTransportSendStream': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'."));
        }
        if (!rec.send) return rejectedWith(rec.sendError ?? sessionError('The stream is closed.'));
        if (!bytes.byteLength) return resolvedWith();
        const req = ++requestSeq;
        const d = deferred();
        writing.set(req, d);
        rec.writes.add(req);
        call('wtWrite', rec.sid, req, base64OfBytes(bytes));
        return d.promise;
      },
      () => {
        if (!rec.send) return rejectedWith(rec.sendError ?? sessionError('The stream is closed.'));
        const req = ++requestSeq;
        const d = deferred();
        writing.set(req, d);
        rec.writes.add(req);
        call('wtFinish', rec.sid, req);
        return apply(pThen, d.promise, [() => sideOver(rec, 'send')]);
      },
      (reason: Any) => {
        if (rec.send) {
          call('wtReset', rec.sid, codeOf(reason));
          sideOver(rec, 'send');
        }
        return resolvedWith();
      },
      1,
      undefined,
      obj,
    );
    // An abort is told the sink at once, through its signal, not once what
    // is in flight is done (WebTransport, "abort a WebTransportSendStream"):
    // the write or the close under way rejects with the reason, and the
    // stream is reset with its code.
    const signal = S.writableSignal(ws);
    signal.addEventListener('abort', () => {
      const reason = signal.reason;
      if (rec.send) {
        call('wtReset', rec.sid, codeOf(reason));
        sideOver(rec, 'send');
      }
      rec.sendError = reason;
      for (const req of rec.writes) {
        const d = writing.get(req);
        writing.delete(req);
        d?.reject(reason);
      }
      rec.writes.clear();
    });
    return obj;
  };

  // --- receive streams ----------------------------------------------------------

  class WebTransportReceiveStream extends ReadableStream {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
      super(S.INTERNAL);
    }
    getStats(): Promise<Any> {
      const r = slotOf(this);
      if (!r || r.tag !== 'WTRS') return rejectedWith(illegal());
      return askStats(r.stream.t, 'wtStreamStats', r.stream.sid, (s: Any) => ({
        bytesReceived: s.bytesReceived ?? 0,
        bytesRead: s.bytesRead ?? 0,
      }));
    }
  }

  /** What the host has of a stream, read into its receive stream. */
  const fill = (rec: Any): boolean => {
    const data = call('wtRead', rec.sid);
    if (typeof data !== 'string' || !data) return false;
    try {
      rec.controller.enqueue(bytesOfBase64(data));
    } catch {}
    return true;
  };
  /** A byte stream closed: a read waiting in the reader's own buffer is
   *  answered with the end, as the source answers it (Streams,
   *  `ReadableByteStreamControllerClose` leaves it to the source). */
  const closeBytes = (controller: Any): void => {
    try {
      controller.close();
    } catch {}
    try {
      controller.byobRequest?.respond(0);
    } catch {}
  };
  const wakePull = (rec: Any): void => {
    const p = rec.pulling;
    rec.pulling = null;
    p?.resolve(undefined);
  };

  const makeReceiveStream = (rec: Any): Any => {
    const obj = new WebTransportReceiveStream(TOKEN);
    own(obj, { tag: 'WTRS', obj, stream: rec });
    rec.receiveObj = obj;
    S.readableBytes(
      () => undefined,
      () => {
        if (!rec.receive) return resolvedWith();
        if (fill(rec)) return resolvedWith();
        if (rec.ended) {
          closeBytes(rec.controller);
          sideOver(rec, 'receive');
          return resolvedWith();
        }
        rec.pulling = deferred();
        return rec.pulling.promise;
      },
      (reason: Any) => {
        if (rec.receive) {
          call('wtStopSending', rec.sid, codeOf(reason));
          sideOver(rec, 'receive');
        }
        wakePull(rec);
        return resolvedWith();
      },
      0,
      obj,
    );
    rec.controller = S.controllerOf(obj);
    return obj;
  };

  class WebTransportBidirectionalStream {
    constructor() {
      throw illegalConstructor();
    }
    get readable(): Any {
      return brand(this, 'WTBS').readable;
    }
    get writable(): Any {
      return brand(this, 'WTBS').writable;
    }
  }

  /** A stream of the session's, by the number the host gave it. */
  const streamRecord = (t: Any, sid: number, send: boolean, receive: boolean) => {
    const rec: Any = {
      sid,
      t,
      send,
      receive,
      ended: false,
      pulling: null,
      controller: null,
      writes: new Set<number>(),
      sendObj: null,
      sendRec: null,
      receiveObj: null,
      sendError: null,
    };
    streamsById.set(sid, rec);
    t.streams.add(rec);
    return rec;
  };
  const makeBidirectional = (t: Any, sid: number, priority: Any): Any => {
    const rec = streamRecord(t, sid, true, true);
    const obj = objectCreate(WebTransportBidirectionalStream.prototype);
    own(obj, {
      tag: 'WTBS',
      readable: makeReceiveStream(rec),
      writable: makeSendStream(rec, priority),
    });
    return obj;
  };
  const makeOutgoing = (t: Any, sid: number, priority: Any): Any =>
    makeSendStream(streamRecord(t, sid, true, false), priority);
  const makeIncoming = (t: Any, sid: number): Any =>
    makeReceiveStream(streamRecord(t, sid, false, true));

  // --- send groups ---------------------------------------------------------------

  class WebTransportSendGroup {
    constructor() {
      throw illegalConstructor();
    }
    getStats(): Promise<Any> {
      const g = slotOf(this);
      if (!g || g.tag !== 'WTSG') return rejectedWith(illegal());
      const req = ++requestSeq;
      const d = deferred();
      statsAsked.set(req, {
        d,
        shape: (s: Any) => ({
          bytesWritten: s.bytesWritten ?? 0,
          bytesSent: s.bytesSent ?? 0,
          bytesAcknowledged: s.bytesAcknowledged ?? 0,
        }),
      });
      call('wtGroupStats', g.t.id, g.number, req);
      return d.promise;
    }
  }
  /** A send group argument: a group of this session's, or null. */
  const groupArgument = (t: Any, group: Any): Any => {
    if (group === null || group === undefined) return null;
    const g = slotOf(group);
    if (!g || g.tag !== 'WTSG') {
      throw typeError("The provided value is not of type 'WebTransportSendGroup'.");
    }
    if (g.t !== t) {
      throw domError('The send group is of another WebTransport.', 'InvalidStateError');
    }
    return g;
  };
  const sendOptions = (t: Any, options: Any, withWait: boolean): Any => {
    const d = dictionary(options, 'WebTransportSendStreamOptions');
    let sendGroup: Any = null;
    let sendOrder = 0;
    let waitUntilAvailable = false;
    if (d) {
      const g = d.sendGroup;
      if (g !== undefined && g !== null) {
        const r = slotOf(g);
        if (!r || r.tag !== 'WTSG') {
          throw typeError("Failed to read the 'sendGroup' property: The provided value is not of type 'WebTransportSendGroup'.");
        }
        sendGroup = r;
      }
      if (d.sendOrder !== undefined) sendOrder = longLong(d.sendOrder);
      if (withWait) waitUntilAvailable = !!d.waitUntilAvailable;
    }
    if (sendGroup && sendGroup.t !== t) {
      throw domError('The send group is of another WebTransport.', 'InvalidStateError');
    }
    return { sendGroup, sendOrder, waitUntilAvailable };
  };

  // --- stats ------------------------------------------------------------------

  const askStats = (
    t: Any,
    op: string,
    target: number,
    shape: (s: Any) => Any,
  ): Promise<Any> => {
    const req = ++requestSeq;
    const d = deferred();
    statsAsked.set(req, { d, shape, t });
    call(op, target, req);
    return d.promise;
  };
  /** The connection's figures as the page has them: what is known, and
   *  the session's datagrams' own. */
  const connectionStats = (t: Any) => (s: Any): Any => {
    const out: Any = {};
    for (const key of [
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
    ]) {
      if (typeof s?.[key] === 'number') out[key] = s[key];
    }
    out.datagrams = {
      droppedIncoming: t.dg.droppedIncoming,
      expiredIncoming: t.dg.expiredIncoming,
      expiredOutgoing: t.dg.expiredOutgoing,
    };
    out.estimatedSendRate =
      typeof s?.estimatedSendRate === 'number' ? s.estimatedSendRate : null;
    out.atSendCapacity = s?.atSendCapacity === true;
    return out;
  };

  // --- datagrams --------------------------------------------------------------

  class WebTransportDatagramsWritable extends WritableStream {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
      super(S.INTERNAL);
    }
    get sendGroup(): Any {
      const r = brand(this, 'WTDW');
      return r.sendGroup ? r.sendGroup.obj : null;
    }
    set sendGroup(group: Any) {
      const r = brand(this, 'WTDW');
      r.sendGroup = groupArgument(r.t, group);
    }
    get sendOrder(): number {
      return brand(this, 'WTDW').sendOrder;
    }
    set sendOrder(order: Any) {
      brand(this, 'WTDW').sendOrder = longLong(order);
    }
  }

  /** The datagrams' implementation-defined starting points. */
  const INITIAL_MAX_DATAGRAM = 1024;
  const INITIAL_BUFFERED = 64;

  class WebTransportDatagramDuplexStream {
    constructor() {
      throw illegalConstructor();
    }
    createWritable(options: Any = undefined): Any {
      const dg = brand(this, 'WTDD');
      const o = sendOptions(dg.t, options, false);
      return makeDatagramsWritable(dg.t, o);
    }
    get readable(): Any {
      return brand(this, 'WTDD').readable;
    }
    get maxDatagramSize(): number {
      const dg = brand(this, 'WTDD');
      return maxDatagramOf(dg.t);
    }
    get incomingMaxAge(): number | null {
      return brand(this, 'WTDD').incomingMaxAge;
    }
    set incomingMaxAge(v: Any) {
      const dg = brand(this, 'WTDD');
      dg.incomingMaxAge = maxAge(v);
    }
    get outgoingMaxAge(): number | null {
      return brand(this, 'WTDD').outgoingMaxAge;
    }
    set outgoingMaxAge(v: Any) {
      const dg = brand(this, 'WTDD');
      dg.outgoingMaxAge = maxAge(v);
    }
    get incomingMaxBufferedDatagrams(): number {
      return brand(this, 'WTDD').incomingHighWaterMark;
    }
    set incomingMaxBufferedDatagrams(v: Any) {
      const dg = brand(this, 'WTDD');
      dg.incomingHighWaterMark = Math.max(1, unsignedLong(v));
      dropIncomingOverflow(dg);
    }
    get outgoingMaxBufferedDatagrams(): number {
      return brand(this, 'WTDD').outgoingHighWaterMark;
    }
    set outgoingMaxBufferedDatagrams(v: Any) {
      const dg = brand(this, 'WTDD');
      dg.outgoingHighWaterMark = Math.max(1, unsignedLong(v));
    }
  }
  /** An age limit as a page sets one: a positive number, or null for
   *  none — 0 is none too, and a negative one or NaN is refused. */
  const maxAge = (v: Any): number | null => {
    if (v === null) return null;
    const x = +v;
    if (Number.isNaN(x) || x < 0) {
      throw rangeError('The value must be a non-negative number.');
    }
    return x === 0 ? null : x;
  };
  const maxDatagramOf = (t: Any): number => {
    if (t.state !== 'connected' && t.state !== 'draining') {
      return INITIAL_MAX_DATAGRAM;
    }
    const n = call('wtMaxDatagram', t.id);
    return typeof n === 'number' ? n : 0;
  };

  const makeDatagrams = (t: Any, bytes: boolean): Any => {
    const obj = objectCreate(WebTransportDatagramDuplexStream.prototype);
    const dg: Any = {
      tag: 'WTDD',
      obj,
      t,
      bytes,
      readable: null,
      incoming: [] as { bytes: Uint8Array; at: number }[],
      pull: null as Deferred | null,
      outgoing: [] as Any[],
      flushing: false,
      writables: new Set<Any>(),
      incomingMaxAge: null,
      outgoingMaxAge: null,
      incomingHighWaterMark: INITIAL_BUFFERED,
      outgoingHighWaterMark: INITIAL_BUFFERED,
      droppedIncoming: 0,
      expiredIncoming: 0,
      expiredOutgoing: 0,
    };
    own(obj, dg);
    const pull = (): Promise<Any> => {
      if (deliverDatagram(dg)) return resolvedWith();
      dg.pull = deferred();
      return dg.pull.promise;
    };
    const cancel = (): Promise<Any> => {
      dg.incoming = [];
      return resolvedWith();
    };
    dg.readable = bytes
      ? S.readableBytes(() => undefined, pull, cancel, 0)
      : S.readable(() => undefined, pull, cancel, 0);
    dg.controller = S.controllerOf(dg.readable);
    return dg;
  };
  /** The oldest datagrams past the incoming high-water mark go. */
  const dropIncomingOverflow = (dg: Any): void => {
    while (dg.incoming.length > dg.incomingHighWaterMark) {
      dg.incoming.shift();
      dg.droppedIncoming += 1;
    }
  };
  /** A datagram that waits handed to the readable, where one is wanted:
   *  into the reader's own buffer where it brought one, which has to be
   *  large enough for all of it. */
  const deliverDatagram = (dg: Any): boolean => {
    const at = now();
    while (dg.incoming.length) {
      const next = dg.incoming.shift();
      if (dg.incomingMaxAge !== null && at - next.at > dg.incomingMaxAge) {
        dg.expiredIncoming += 1;
        continue;
      }
      const c = dg.controller;
      if (dg.bytes) {
        const request = c.byobRequest;
        if (request) {
          const view = request.view;
          if (view.byteLength < next.bytes.byteLength) {
            const e = rangeError('The buffer is too small for the datagram.');
            try {
              c.error(e);
            } catch {}
            return true;
          }
          new U8(view.buffer, view.byteOffset, next.bytes.byteLength).set(
            next.bytes,
          );
          request.respond(next.bytes.byteLength);
          return true;
        }
      }
      try {
        c.enqueue(next.bytes);
      } catch {}
      return true;
    }
    return false;
  };
  const datagramArrived = (t: Any, bytes: Uint8Array): void => {
    const dg = t.dg;
    dg.incoming.push({ bytes, at: now() });
    dropIncomingOverflow(dg);
    if (dg.pull) {
      const p = dg.pull;
      if (deliverDatagram(dg)) {
        dg.pull = null;
        p.resolve(undefined);
      }
    }
  };

  const makeDatagramsWritable = (t: Any, o: Any): Any => {
    const obj = new WebTransportDatagramsWritable(TOKEN);
    const r = {
      tag: 'WTDW',
      obj,
      t,
      sendGroup: o.sendGroup,
      sendOrder: o.sendOrder,
    };
    own(obj, r);
    const dg = t.dg;
    dg.writables.add(obj);
    S.writable(
      () => undefined,
      (chunk: Any) => {
        const bytes = bufferBytes(chunk);
        if (bytes === null) {
          return rejectedWith(typeError("Failed to execute 'write' on 'WebTransportDatagramsWritable': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'."));
        }
        if (t.state === 'closed' || t.state === 'failed') {
          return rejectedWith(domError('The session is closed.', 'InvalidStateError'));
        }
        const d = deferred();
        dg.outgoing.push({ bytes, at: now(), d, writable: r });
        if (dg.outgoing.length < dg.outgoingHighWaterMark) d.resolve(undefined);
        if (t.state === 'connected' || t.state === 'draining') flushSoon(t);
        return d.promise;
      },
      () => resolvedWith(),
      () => resolvedWith(),
      1,
      undefined,
      obj,
    );
    return obj;
  };
  /** The datagrams queued sent a task on, as a browser's network thread
   *  sends them: the queue fills while a page writes in one task. */
  const flushSoon = (t: Any): void => {
    const dg = t.dg;
    if (dg.flushing) return;
    dg.flushing = true;
    setTimer(() => {
      dg.flushing = false;
      flushDatagrams(t);
    }, 0);
  };
  const flushDatagrams = (t: Any): void => {
    const dg = t.dg;
    if (t.state !== 'connected' && t.state !== 'draining') return;
    const max = maxDatagramOf(t);
    const at = now();
    const queue = dg.outgoing;
    dg.outgoing = [];
    for (const item of queue) {
      if (dg.outgoingMaxAge !== null && at - item.at > dg.outgoingMaxAge) {
        dg.expiredOutgoing += 1;
      } else if (item.bytes.byteLength <= max) {
        call(
          'wtDatagram',
          t.id,
          base64OfBytes(item.bytes),
          JSON.stringify({
            sendOrder: item.writable.sendOrder,
            sendGroup: item.writable.sendGroup ? item.writable.sendGroup.number : null,
          }),
        );
      }
      item.d.resolve(undefined);
    }
  };

  // --- the session ----------------------------------------------------------------

  const CONGESTION = ['default', 'throughput', 'low-latency'];

  /** `WebTransportOptions`, its members read in Web IDL's order. */
  const optionsOf = (options: Any): Any => {
    const context = "Failed to construct 'WebTransport'";
    const d = dictionary(options, 'WebTransportOptions');
    const o: Any = {
      allowPooling: false,
      anticipatedBidi: null,
      anticipatedUni: null,
      congestionControl: 'default',
      datagramsReadableType: undefined,
      headers: [],
      protocols: [],
      requireUnreliable: false,
      serverCertificateHashes: [],
    };
    if (!d) return o;
    o.allowPooling = !!d.allowPooling;
    const bidi = d.anticipatedConcurrentIncomingBidirectionalStreams;
    if (bidi !== undefined && bidi !== null) {
      o.anticipatedBidi = enforceRange(bidi, 65535, context);
    }
    const uni = d.anticipatedConcurrentIncomingUnidirectionalStreams;
    if (uni !== undefined && uni !== null) {
      o.anticipatedUni = enforceRange(uni, 65535, context);
    }
    if (d.congestionControl !== undefined) {
      const c = `${d.congestionControl}`;
      if (!CONGESTION.includes(c)) {
        throw typeError(`${context}: The provided value '${c}' is not a valid enum value of type WebTransportCongestionControl.`);
      }
      o.congestionControl = c;
    }
    if (d.datagramsReadableType !== undefined) {
      const type = `${d.datagramsReadableType}`;
      if (type !== 'bytes') {
        throw typeError(`${context}: The provided value '${type}' is not a valid enum value of type ReadableStreamType.`);
      }
      o.datagramsReadableType = type;
    }
    if (d.headers !== undefined) {
      const list: [string, string][] = [];
      new Headers(d.headers).forEach((value: string, name: string) => {
        list.push([name, value]);
      });
      o.headers = list;
    }
    if (d.protocols !== undefined) {
      o.protocols = sequence(d.protocols, context).map((p) => `${p}`);
    }
    o.requireUnreliable = !!d.requireUnreliable;
    if (d.serverCertificateHashes !== undefined) {
      o.serverCertificateHashes = sequence(d.serverCertificateHashes, context).map(
        (h) => {
          const hd = dictionary(h, 'WebTransportHash');
          const algorithm = hd ? hd.algorithm : undefined;
          if (algorithm === undefined) {
            throw typeError(`${context}: Failed to read the 'algorithm' property from 'WebTransportHash': Required member is undefined.`);
          }
          const value = hd.value;
          if (value === undefined) {
            throw typeError(`${context}: Failed to read the 'value' property from 'WebTransportHash': Required member is undefined.`);
          }
          const bytes = bufferBytes(value);
          if (bytes === null) {
            throw typeError(`${context}: Failed to read the 'value' property from 'WebTransportHash': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.`);
          }
          return { algorithm: `${algorithm}`, value: base64OfBytes(bytes) };
        },
      );
    }
    return o;
  };

  /**
   * Cleanup (W3C WebTransport): every stream and datagram writable errored
   * with `error`, and the session closed with `closeInfo` — `closed`
   * resolved and the incoming streams closed — or, with none, failed:
   * `ready` and `closed` rejected, the incoming streams errored.
   */
  const cleanup = (t: Any, error: Any, closeInfo: Any): void => {
    if (t.state === 'closed' || t.state === 'failed') return;
    t.state = closeInfo ? 'closed' : 'failed';
    for (const rec of t.streams) {
      if (rec.send && rec.sendObj) {
        rec.sendError = error;
        try {
          S.errorWritable(rec.sendObj, error);
        } catch {}
      }
      if (rec.receive && rec.receiveObj) {
        try {
          S.errorReadable(rec.receiveObj, error);
        } catch {}
        wakePull(rec);
      }
      for (const req of rec.writes) {
        const d = writing.get(req);
        writing.delete(req);
        d?.reject(error);
      }
      rec.writes.clear();
      rec.send = false;
      rec.receive = false;
      streamsById.delete(rec.sid);
    }
    t.streams.clear();
    const dg = t.dg;
    for (const w of dg.writables) {
      try {
        S.errorWritable(w, error);
      } catch {}
    }
    for (const item of dg.outgoing) item.d.resolve(undefined);
    dg.outgoing = [];
    for (const [req, c] of creating) {
      if (c.t !== t) continue;
      creating.delete(req);
      c.d.reject(domError('The session is closed.', 'InvalidStateError'));
    }
    if (t.ready.state === 0) {
      t.ready.reject(error);
      markHandled(t.ready.promise);
    }
    if (closeInfo) {
      t.closed.resolve(closeInfo);
      for (const s of [t.incomingBidi, t.incomingUni]) {
        try {
          S.controllerOf(s).close();
        } catch {}
      }
      closeBytes(dg.controller);
      const p = dg.pull;
      dg.pull = null;
      p?.resolve(undefined);
    } else {
      t.closed.reject(error);
      markHandled(t.closed.promise);
      for (const s of [t.incomingBidi, t.incomingUni]) {
        try {
          S.errorReadable(s, error);
        } catch {}
      }
      try {
        S.errorReadable(dg.readable, error);
      } catch {}
      const p = dg.pull;
      dg.pull = null;
      p?.resolve(undefined);
    }
    t.draining.resolve(undefined);
    sessions.delete(t.id);
  };

  /** The streams a session's server opens, as a stream of them. */
  const incomingStreams = (): Any =>
    S.readable(
      () => undefined,
      () => resolvedWith(),
      () => resolvedWith(),
      0,
    );

  class WebTransport {
    constructor(url: Any, options: Any = undefined) {
      const context = "Failed to construct 'WebTransport'";
      if (arguments.length < 1) {
        throw typeError(`${context}: 1 argument required, but only 0 present.`);
      }
      const href = usv(url);
      const o = optionsOf(options);
      let parsed: Any;
      try {
        parsed = new URLClass(href);
      } catch {
        throw domError(`${context}: The URL '${href}' is invalid.`, 'SyntaxError');
      }
      if (parsed.protocol !== 'https:') {
        throw domError(`${context}: The URL's scheme must be 'https'. '${parsed.protocol.slice(0, -1)}' is not allowed.`, 'SyntaxError');
      }
      if (parsed.href.includes('#')) {
        throw domError(`${context}: The URL contains a fragment identifier ('#${parsed.hash.slice(1)}'). Fragment identifiers are not allowed in WebTransport URLs.`, 'SyntaxError');
      }
      if (o.allowPooling && o.serverCertificateHashes.length) {
        throw domError(`${context}: serverCertificateHashes is not supported with allowPooling.`, 'NotSupportedError');
      }
      const seen = new Set<string>();
      for (const p of o.protocols) {
        if (!validProtocol(p) || seen.has(p)) {
          throw domError(`${context}: Invalid protocol name '${p}'.`, 'SyntaxError');
        }
        seen.add(p);
      }
      const id = ++sessionSeq;
      const t: Any = {
        tag: 'WT',
        obj: this,
        id,
        state: 'connecting',
        ready: deferred(),
        closed: deferred(),
        draining: deferred(),
        protocol: '',
        reliability: 'pending',
        congestionControl: o.congestionControl,
        anticipatedUni: o.anticipatedUni,
        anticipatedBidi: o.anticipatedBidi,
        responseHeaders: null,
        streams: new Set(),
        incomingBidi: incomingStreams(),
        incomingUni: incomingStreams(),
        dg: null,
      };
      t.dg = makeDatagrams(t, o.datagramsReadableType === 'bytes');
      own(this, t);
      sessions.set(id, t);
      call(
        'wtOpen',
        id,
        JSON.stringify({
          url: parsed.href,
          protocols: o.protocols,
          headers: o.headers,
          serverCertificateHashes: o.serverCertificateHashes,
          allowPooling: o.allowPooling,
          requireUnreliable: o.requireUnreliable,
          congestionControl: o.congestionControl,
          anticipatedConcurrentIncomingUnidirectionalStreams: o.anticipatedUni,
          anticipatedConcurrentIncomingBidirectionalStreams: o.anticipatedBidi,
        }),
      );
    }
    static get supportsReliableOnly(): boolean {
      return false;
    }
    getStats(): Promise<Any> {
      const t = slotOf(this);
      if (!t || t.tag !== 'WT') return rejectedWith(illegal());
      if (t.state === 'failed') {
        return rejectedWith(domError('The session failed.', 'InvalidStateError'));
      }
      const req = ++requestSeq;
      const d = deferred();
      statsAsked.set(req, { d, shape: connectionStats(t), t });
      call('wtStats', t.id, req);
      return d.promise;
    }
    exportKeyingMaterial(
      label: Any,
      context: Any,
      outputLength: Any,
    ): Promise<Any> {
      const t = slotOf(this);
      if (!t || t.tag !== 'WT') return rejectedWith(illegal());
      void label;
      void context;
      void outputLength;
      return rejectedWith(domError('Exporting keying material is not supported.', 'NotSupportedError'));
    }
    get ready(): Promise<Any> {
      const t = slotOf(this);
      if (!t || t.tag !== 'WT') return rejectedWith(illegal());
      return t.ready.promise;
    }
    get reliability(): string {
      return brand(this, 'WT').reliability;
    }
    get congestionControl(): string {
      return brand(this, 'WT').congestionControl;
    }
    get anticipatedConcurrentIncomingUnidirectionalStreams(): number | null {
      return brand(this, 'WT').anticipatedUni;
    }
    set anticipatedConcurrentIncomingUnidirectionalStreams(v: Any) {
      const t = brand(this, 'WT');
      t.anticipatedUni =
        v === null || v === undefined
          ? null
          : enforceRange(v, 65535, "Failed to set the 'anticipatedConcurrentIncomingUnidirectionalStreams' property on 'WebTransport'");
    }
    get anticipatedConcurrentIncomingBidirectionalStreams(): number | null {
      return brand(this, 'WT').anticipatedBidi;
    }
    set anticipatedConcurrentIncomingBidirectionalStreams(v: Any) {
      const t = brand(this, 'WT');
      t.anticipatedBidi =
        v === null || v === undefined
          ? null
          : enforceRange(v, 65535, "Failed to set the 'anticipatedConcurrentIncomingBidirectionalStreams' property on 'WebTransport'");
    }
    get responseHeaders(): Any {
      return brand(this, 'WT').responseHeaders;
    }
    get protocol(): string {
      return brand(this, 'WT').protocol;
    }
    get closed(): Promise<Any> {
      const t = slotOf(this);
      if (!t || t.tag !== 'WT') return rejectedWith(illegal());
      return t.closed.promise;
    }
    get draining(): Promise<Any> {
      const t = slotOf(this);
      if (!t || t.tag !== 'WT') return rejectedWith(illegal());
      return t.draining.promise;
    }
    close(closeInfo: Any = undefined): void {
      const t = brand(this, 'WT');
      const d = dictionary(closeInfo, 'WebTransportCloseInfo');
      const closeCode = d && d.closeCode !== undefined ? unsignedLong(d.closeCode) : 0;
      const reason = d && d.reason !== undefined ? usv(d.reason) : '';
      if (t.state === 'closed' || t.state === 'failed') return;
      if (t.state === 'connecting') {
        call('wtClose', t.id, 0, '');
        cleanup(t, sessionError('The session was closed before it was established.'), null);
        return;
      }
      call('wtClose', t.id, closeCode, truncatedReason(reason));
      cleanup(t, domError('The session was closed.', 'AbortError'), {
        closeCode,
        reason,
      });
    }
    get datagrams(): Any {
      return brand(this, 'WT').dg.obj;
    }
    createBidirectionalStream(options: Any = undefined): Promise<Any> {
      return createStream(this, options, true);
    }
    get incomingBidirectionalStreams(): Any {
      return brand(this, 'WT').incomingBidi;
    }
    createUnidirectionalStream(options: Any = undefined): Promise<Any> {
      return createStream(this, options, false);
    }
    get incomingUnidirectionalStreams(): Any {
      return brand(this, 'WT').incomingUni;
    }
    createSendGroup(): Any {
      const t = brand(this, 'WT');
      if (t.state === 'closed' || t.state === 'failed') {
        throw domError('The session is closed.', 'InvalidStateError');
      }
      const obj = objectCreate(WebTransportSendGroup.prototype);
      const number = call('wtGroup', t.id);
      own(obj, { tag: 'WTSG', obj, t, number: typeof number === 'number' ? number : 0 });
      return obj;
    }
  }

  const createStream = (self: Any, options: Any, bidi: boolean): Promise<Any> => {
    const t = slotOf(self);
    if (!t || t.tag !== 'WT') return rejectedWith(illegal());
    let o: Any;
    try {
      o = sendOptions(t, options, true);
    } catch (e) {
      return rejectedWith(e);
    }
    if (t.state === 'closed' || t.state === 'failed') {
      return rejectedWith(domError('The session is closed.', 'InvalidStateError'));
    }
    const req = ++requestSeq;
    const d = deferred();
    creating.set(req, { d, t, bidi, priority: o });
    call(
      'wtCreate',
      t.id,
      req,
      JSON.stringify({
        bidirectional: bidi,
        sendOrder: o.sendOrder,
        sendGroup: o.sendGroup ? o.sendGroup.number : null,
        waitUntilAvailable: o.waitUntilAvailable,
      }),
    );
    return d.promise;
  };

  // --- what the host tells the page ---------------------------------------------------

  entry('__wtReady', () => {
    const [id, info] = input();
    const t = sessions.get(id);
    if (!t || t.state !== 'connecting') return false;
    t.state = 'connected';
    t.protocol = `${info.protocol ?? ''}`;
    t.reliability = info.reliability;
    t.congestionControl = info.congestionControl;
    if (Array.isArray(info.responseHeaders)) {
      t.responseHeaders = new Headers(info.responseHeaders);
    }
    t.ready.resolve(undefined);
    if (t.dg.outgoing.length) flushSoon(t);
    return true;
  });
  entry('__wtFailed', () => {
    const [id, message] = input();
    const t = sessions.get(id);
    if (!t) return false;
    cleanup(t, sessionError(`${message}`), null);
    return true;
  });
  entry('__wtClosed', () => {
    const [id, closeCode, reason] = input();
    const t = sessions.get(id);
    if (!t) return false;
    cleanup(t, sessionError('The session was closed by the server.'), {
      closeCode,
      reason,
    });
    return true;
  });
  entry('__wtDraining', () => {
    const [id] = input();
    const t = sessions.get(id);
    if (!t) return false;
    if (t.state === 'connected') t.state = 'draining';
    t.draining.resolve(undefined);
    return true;
  });
  entry('__wtDatagram', () => {
    const [id, data] = input();
    const t = sessions.get(id);
    if (!t) return false;
    datagramArrived(t, bytesOfBase64(data));
    return true;
  });
  entry('__wtIncoming', () => {
    const [id, sid, bidi] = input();
    const t = sessions.get(id);
    if (!t) return false;
    const stream = bidi
      ? makeBidirectional(t, sid, { sendOrder: 0, sendGroup: null })
      : makeIncoming(t, sid);
    try {
      S.controllerOf(bidi ? t.incomingBidi : t.incomingUni).enqueue(stream);
    } catch {}
    return true;
  });
  entry('__wtCreated', () => {
    const [req, sid, error] = input();
    const c = creating.get(req);
    if (!c) return false;
    creating.delete(req);
    if (sid === null) {
      c.d.reject(domError(`The stream could not be opened: ${error}.`, 'InvalidStateError'));
      return true;
    }
    c.d.resolve(
      c.bidi
        ? makeBidirectional(c.t, sid, c.priority)
        : makeOutgoing(c.t, sid, c.priority),
    );
    return true;
  });
  entry('__wtWritten', () => {
    const [sid, req, error] = input();
    const d = writing.get(req);
    if (!d) return false;
    writing.delete(req);
    const rec = streamsById.get(sid);
    rec?.writes.delete(req);
    if (error === null) d.resolve(undefined);
    else d.reject(rec?.sendError ?? streamError(`${error}`, null));
    return true;
  });
  entry('__wtReadable', () => {
    const [sid] = input();
    const rec = streamsById.get(sid);
    if (!rec || !rec.receive || !rec.pulling) return false;
    if (fill(rec)) wakePull(rec);
    return true;
  });
  entry('__wtEnd', () => {
    const [sid] = input();
    const rec = streamsById.get(sid);
    if (!rec || !rec.receive) return false;
    rec.ended = true;
    if (rec.pulling) {
      // what is still to read first, then the end
      if (!fill(rec)) {
        closeBytes(rec.controller);
        sideOver(rec, 'receive');
      }
      wakePull(rec);
    }
    return true;
  });
  entry('__wtReset', () => {
    const [sid, code] = input();
    const rec = streamsById.get(sid);
    if (!rec || !rec.receive) return false;
    const error = streamError('The stream was reset by the server.', code);
    try {
      S.errorReadable(rec.receiveObj, error);
    } catch {}
    sideOver(rec, 'receive');
    wakePull(rec);
    return true;
  });
  entry('__wtStopSending', () => {
    const [sid, code] = input();
    const rec = streamsById.get(sid);
    if (!rec || !rec.send) return false;
    const error = streamError('The server stopped reading the stream.', code);
    rec.sendError = error;
    try {
      S.errorWritable(rec.sendObj, error);
    } catch {}
    for (const req of rec.writes) {
      const d = writing.get(req);
      writing.delete(req);
      d?.reject(error);
    }
    rec.writes.clear();
    sideOver(rec, 'send');
    return true;
  });
  entry('__wtStats', () => {
    const [req, stats, error] = input();
    const asked = statsAsked.get(req);
    if (!asked) return false;
    statsAsked.delete(req);
    if (error) {
      asked.d.reject(domError('The session failed.', 'InvalidStateError'));
    } else asked.d.resolve(asked.shape(stats ?? {}));
    return true;
  });

  const classes: Record<string, Any> = {
    WebTransport,
    WebTransportError,
    WebTransportDatagramDuplexStream,
    WebTransportDatagramsWritable,
    WebTransportBidirectionalStream,
    WebTransportSendStream,
    WebTransportReceiveStream,
    WebTransportSendGroup,
    WebTransportWriter,
  };
  for (const name of Object.getOwnPropertyNames(classes)) {
    const C = classes[name];
    S.idl(C);
    Object.defineProperty(C.prototype, Symbol.toStringTag, {
      value: name,
      configurable: true,
    });
  }
  return classes;
}
