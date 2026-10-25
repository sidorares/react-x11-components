// WHATWG Streams, as a page's scripts see them: readable streams of either
// kind — a source's chunks, or bytes a reader may bring its own buffer for —
// writable streams that hold a writer back while their queue is full, and
// transform streams between the two, each algorithm the standard's own.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` is handed it and calls it.
//
// Why the standard's algorithms and not a stand-in. The first streams here
// were enough for Next.js's flight data and a fetch piped through a
// decoder: a writer that was never held back, a queue that counted chunks,
// and no reader that brought its own buffer. WebTransport is written
// against all of it — a datagram writer's `ready` that waits while
// `outgoingMaxBufferedDatagrams` are queued, a receive stream read into the
// page's own `ArrayBuffer`, a send stream errored by the peer's
// STOP_SENDING — and so is any code that measures backpressure. What a page
// can tell apart from a browser's is now only what the standard leaves to
// the implementation.
//
// Internal state lives in a `WeakMap` by the public object, never on it, so
// a page reads nothing of it and tampers with none of it, and an interface's
// methods brand-check `this` as Web IDL's do. The promise and array methods
// the algorithms use are taken as this runs, before any page code, so a
// page that replaces `Promise.prototype.then` does not reach into a pipe.

/** What `installDom` is handed back: the interfaces, for the global, and
 *  what another installer in the page's realm builds streams of its own
 *  with — WebTransport's send and receive streams are subclasses. */
export interface StreamsInstall {
  classes: Record<string, unknown>;
  internals: StreamsInternals;
}

/** The operations other page-realm code makes and drives streams with. */
export interface StreamsInternals {
  /** Passed as a stream's first argument, the stream is made with no
   *  controller, for the caller to give it one. */
  INTERNAL: object;
  isReadableStream(x: unknown): boolean;
  isWritableStream(x: unknown): boolean;
  /** A readable stream of chunks over algorithms (CreateReadableStream),
   *  or `into`, a stream made with `INTERNAL`, set up so. */
  readable(
    start: () => unknown,
    pull: () => Promise<unknown>,
    cancel: (reason: unknown) => Promise<unknown>,
    highWaterMark?: number,
    size?: (chunk: unknown) => number,
    into?: unknown,
  ): unknown;
  /** A readable byte stream over algorithms (CreateReadableByteStream). */
  readableBytes(
    start: () => unknown,
    pull: () => Promise<unknown>,
    cancel: (reason: unknown) => Promise<unknown>,
    highWaterMark?: number,
    into?: unknown,
  ): unknown;
  /** A writable stream over algorithms (CreateWritableStream). */
  writable(
    start: () => unknown,
    write: (chunk: unknown) => Promise<unknown>,
    close: () => Promise<unknown>,
    abort: (reason: unknown) => Promise<unknown>,
    highWaterMark?: number,
    size?: (chunk: unknown) => number,
    into?: unknown,
  ): unknown;
  /** A readable stream's controller, the public object. */
  controllerOf(stream: unknown): unknown;
  /** A readable stream's state, and its stored error. */
  readableState(stream: unknown): 'readable' | 'closed' | 'errored';
  /** A writable stream's state. */
  writableState(
    stream: unknown,
  ): 'writable' | 'erroring' | 'closed' | 'errored';
  storedError(stream: unknown): unknown;
  /** WritableStreamDefaultControllerErrorIfNeeded. */
  errorWritable(stream: unknown, error: unknown): void;
  /** A writable stream's controller's abort signal, which an abort signals
   *  before anything in flight is done. */
  writableSignal(stream: unknown): any;
  /** ReadableStreamDefaultControllerError / ReadableByteStreamControllerError. */
  errorReadable(stream: unknown, error: unknown): void;
  /** Whether a close is queued or under way (WritableStreamCloseQueuedOrInFlight). */
  closeQueuedOrInFlight(stream: unknown): boolean;
  /** A writable stream's desired size, or null. */
  writableDesiredSize(stream: unknown): number | null;
  /** The pending read requests a readable stream's reader has. */
  readRequests(stream: unknown): number;
  /** An interface's members as Web IDL has them: enumerable, and
   *  `length`s of its operations as the IDL counts them. */
  idl(Interface: unknown): void;
}

export function installStreams(
  abortController: () => unknown,
  abortSignal: () => unknown,
): StreamsInstall {
  'use strict';
  type Any = any;
  // asked for as they are needed: the facade defines its abort classes
  // after the streams it builds on these
  const AbortControllerCtor = (): Any => abortController();
  const AbortSignalCtor = (): Any => abortSignal();

  // --- what the algorithms call, taken before any page code runs -------------

  const P: Any = Promise;
  const pThen: Any = P.prototype.then;
  const apply: Any = Reflect.apply;
  const WM: Any = WeakMap;
  const wmGet: Any = WM.prototype.get;
  const wmSet: Any = WM.prototype.set;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const getOwnPropertyNames = Object.getOwnPropertyNames;
  const getPrototypeOf = Object.getPrototypeOf;
  const hasOwn = Object.prototype.hasOwnProperty;
  const objectCreate = Object.create;
  const isFiniteNumber = Number.isFinite;
  const isNaNNumber = Number.isNaN;
  const mathMin = Math.min;
  const mathTrunc = Math.trunc;
  const AB: Any = ArrayBuffer;
  const abProto = AB.prototype;
  const abByteLength: Any = getOwnPropertyDescriptor(abProto, 'byteLength')!.get;
  const abDetached: Any = getOwnPropertyDescriptor(abProto, 'detached')?.get;
  const abTransfer: Any = abProto.transfer;
  const abSlice: Any = abProto.slice;
  const isView: Any = AB.isView;
  const U8: Any = Uint8Array;
  const u8Set: Any = U8.prototype.set;
  const TA_PROTO = getPrototypeOf(U8.prototype);
  const taName: Any = getOwnPropertyDescriptor(TA_PROTO, Symbol.toStringTag)!.get;
  const taBuffer: Any = getOwnPropertyDescriptor(TA_PROTO, 'buffer')!.get;
  const taByteOffset: Any = getOwnPropertyDescriptor(TA_PROTO, 'byteOffset')!.get;
  const taByteLength: Any = getOwnPropertyDescriptor(TA_PROTO, 'byteLength')!.get;
  const taLength: Any = getOwnPropertyDescriptor(TA_PROTO, 'length')!.get;
  const DV: Any = DataView;
  const dvBuffer: Any = getOwnPropertyDescriptor(DV.prototype, 'buffer')!.get;
  const dvByteOffset: Any = getOwnPropertyDescriptor(DV.prototype, 'byteOffset')!.get;
  const dvByteLength: Any = getOwnPropertyDescriptor(DV.prototype, 'byteLength')!.get;
  const G: Any = globalThis;
  const TYPED: Record<string, Any> = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  };
  if (typeof G.Float16Array === 'function') TYPED.Float16Array = G.Float16Array;
  const AsyncIteratorPrototype = getPrototypeOf(
    getPrototypeOf(async function* () {}).prototype,
  );

  const noop = (): void => {};
  const typeError = (message: string): Any => new TypeError(message);
  const rangeError = (message: string): Any => new RangeError(message);
  const illegal = (): Any => typeError('Illegal invocation');
  const illegalConstructor = (): Any => typeError('Illegal constructor');
  const isObject = (v: Any): boolean =>
    (typeof v === 'object' && v !== null) || typeof v === 'function';

  /** Every stream object's internal slots, by the object. */
  const SLOTS = new WM();
  const slotOf = (x: Any): Any =>
    isObject(x) ? apply(wmGet, SLOTS, [x]) : undefined;
  const own = (x: Any, record: Any): void => {
    apply(wmSet, SLOTS, [x, record]);
  };
  /** The slots of `x`, which has to be of the interface `tag`. */
  const brand = (x: Any, tag: string): Any => {
    const r = slotOf(x);
    if (!r || r.tag !== tag) throw illegal();
    return r;
  };

  // --- promises, as the standard settles them --------------------------------

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
  const react = (p: Promise<Any>, f?: Any, r?: Any): Promise<Any> =>
    apply(pThen, p, [f, r]);
  /** Upon fulfilment or rejection: the reaction's own promise is no one's. */
  const upon = (p: Promise<Any>, f?: Any, r?: Any): void => {
    markHandled(apply(pThen, p, [f, r]));
  };
  /** A microtask, as the standard queues one. */
  const microtask = (fn: () => void): void => {
    upon(resolvedWith(), fn);
  };
  const resolvedDeferred = (v?: Any): Deferred => {
    const d = deferred();
    d.resolve(v);
    return d;
  };
  const rejectedDeferred = (e: Any): Deferred => {
    const d = deferred();
    d.reject(e);
    markHandled(d.promise);
    return d;
  };

  /** A callback the page gave, called as Web IDL calls one that returns a
   *  promise: what it throws is the promise's rejection. */
  const promiseCall = (fn: Any, self: Any, args: Any[]): Promise<Any> => {
    try {
      return resolvedWith(apply(fn, self, args));
    } catch (e) {
      return rejectedWith(e);
    }
  };

  // --- a queue no page reaches into --------------------------------------------

  class Queue<T> {
    _items: T[] = [];
    _head = 0;
    get length(): number {
      return this._items.length - this._head;
    }
    push(v: T): void {
      this._items[this._items.length] = v;
    }
    shift(): T {
      const v = this._items[this._head];
      (this._items as Any)[this._head] = undefined;
      this._head += 1;
      if (this._head === this._items.length) {
        this._items = [];
        this._head = 0;
      } else if (this._head > 1024 && this._head * 2 > this._items.length) {
        const rest: T[] = [];
        for (let i = this._head; i < this._items.length; i += 1) {
          rest[rest.length] = this._items[i];
        }
        this._items = rest;
        this._head = 0;
      }
      return v;
    }
    peek(): T {
      return this._items[this._head];
    }
    at(i: number): T {
      return this._items[this._head + i];
    }
    clear(): void {
      this._items = [];
      this._head = 0;
    }
  }

  // --- Web IDL's conversions ------------------------------------------------

  /** A dictionary argument: undefined and null are empty, any other
   *  non-object is refused. */
  const dictionary = (v: Any, name: string): Any => {
    if (v === undefined || v === null) return null;
    if (!isObject(v)) {
      throw typeError(`The provided value is not of type '${name}'.`);
    }
    return v;
  };
  const callbackMember = (d: Any, key: string, context: string): Any => {
    if (!d) return undefined;
    const f = d[key];
    if (f === undefined) return undefined;
    if (typeof f !== 'function') {
      throw typeError(`${context}: member ${key} is not a function.`);
    }
    return f;
  };
  /** `[EnforceRange] unsigned long long`. */
  const enforceRange = (v: Any, context: string): number => {
    const x = +v;
    if (!isFiniteNumber(x)) {
      throw typeError(`${context}: the value is not a finite number.`);
    }
    const t = mathTrunc(x);
    if (t < 0 || t > 9007199254740991) {
      throw typeError(`${context}: the value is outside the accepted range.`);
    }
    return t === 0 ? 0 : t;
  };
  const isNonNegativeNumber = (v: Any): boolean =>
    typeof v === 'number' && !isNaNNumber(v) && v >= 0;

  interface Strategy {
    hwm: number | undefined;
    size: Any;
  }
  /** A `QueuingStrategy`, its members read in Web IDL's order. */
  const strategyOf = (s: Any): Strategy => {
    const d = dictionary(s, 'QueuingStrategy');
    if (!d) return { hwm: undefined, size: undefined };
    const raw = d.highWaterMark;
    const hwm = raw === undefined ? undefined : +raw;
    const size = d.size;
    if (size !== undefined && typeof size !== 'function') {
      throw typeError("Failed to read the 'size' property from 'QueuingStrategy': The provided value is not a function.");
    }
    return { hwm, size };
  };
  const extractHighWaterMark = (s: Strategy, fallback: number): number => {
    if (s.hwm === undefined) return fallback;
    if (isNaNNumber(s.hwm) || s.hwm < 0) {
      throw rangeError('Invalid highWaterMark.');
    }
    return s.hwm;
  };
  const extractSizeAlgorithm = (s: Strategy): ((chunk: Any) => number) => {
    const size = s.size;
    if (size === undefined) return () => 1;
    return (chunk: Any) => +apply(size, undefined, [chunk]);
  };

  // --- buffers ------------------------------------------------------------

  const isArrayBuffer = (v: Any): boolean => {
    if (!isObject(v)) return false;
    try {
      apply(abByteLength, v, []);
      return true;
    } catch {
      return false;
    }
  };
  const isDetached = (b: Any): boolean => {
    if (abDetached) return apply(abDetached, b, []);
    try {
      new U8(b);
      return false;
    } catch {
      return true;
    }
  };
  const transferBuffer = (b: Any): Any => {
    if (isDetached(b)) throw typeError('The ArrayBuffer is detached.');
    return abTransfer ? apply(abTransfer, b, []) : apply(abSlice, b, [0]);
  };
  const bufferByteLength = (b: Any): number => apply(abByteLength, b, []);
  /** A view's kind: its typed array's name, `DataView`, or null. */
  const viewKind = (v: Any): string | null => {
    if (!isObject(v) || !isView(v)) return null;
    return apply(taName, v, []) ?? 'DataView';
  };
  interface ViewInfo {
    buffer: Any;
    byteOffset: number;
    byteLength: number;
    length: number;
    elementSize: number;
    ctor: Any;
  }
  const viewInfo = (v: Any): ViewInfo => {
    const kind = viewKind(v)!;
    if (kind === 'DataView') {
      const byteLength = apply(dvByteLength, v, []);
      return {
        buffer: apply(dvBuffer, v, []),
        byteOffset: apply(dvByteOffset, v, []),
        byteLength,
        length: byteLength,
        elementSize: 1,
        ctor: DV,
      };
    }
    const ctor = TYPED[kind];
    return {
      buffer: apply(taBuffer, v, []),
      byteOffset: apply(taByteOffset, v, []),
      byteLength: apply(taByteLength, v, []),
      length: apply(taLength, v, []),
      elementSize: ctor.BYTES_PER_ELEMENT,
      ctor,
    };
  };
  /** An `ArrayBufferView` argument, not over a shared buffer. */
  const viewArgument = (v: Any, context: string): ViewInfo => {
    if (viewKind(v) === null) {
      throw typeError(`${context}: parameter 1 is not of type 'ArrayBufferView'.`);
    }
    const info = viewInfo(v);
    if (!isArrayBuffer(info.buffer)) {
      throw typeError(`${context}: The provided ArrayBufferView value must not be shared.`);
    }
    return info;
  };
  const copyBytes = (
    to: Any,
    toOffset: number,
    from: Any,
    fromOffset: number,
    count: number,
  ): void => {
    apply(u8Set, new U8(to, toOffset, count), [new U8(from, fromOffset, count)]);
  };
  const cloneBuffer = (b: Any, offset: number, length: number): Any =>
    apply(abSlice, b, [offset, offset + length]);

  // --- queues with sizes --------------------------------------------------

  interface Container {
    queue: Queue<Any>;
    queueTotalSize: number;
  }
  const enqueueValueWithSize = (c: Container, value: Any, size: number) => {
    if (!isNonNegativeNumber(size) || size === Infinity) {
      throw rangeError('The chunk size must be a finite, non-negative number.');
    }
    c.queue.push({ value, size });
    c.queueTotalSize += size;
  };
  const dequeueValue = (c: Container): Any => {
    const pair = c.queue.shift();
    c.queueTotalSize -= pair.size;
    if (c.queueTotalSize < 0) c.queueTotalSize = 0;
    return pair.value;
  };
  const peekQueueValue = (c: Container): Any => c.queue.peek().value;
  const resetQueue = (c: Container): void => {
    c.queue = new Queue();
    c.queueTotalSize = 0;
  };

  // ==========================================================================
  // Readable streams
  // ==========================================================================

  const INTERNAL = Object.freeze(objectCreate(null));

  interface ReadRequest {
    chunk(c: Any): void;
    close(c?: Any): void;
    error(e: Any): void;
  }

  const initReadableStream = (obj: Any): Any => {
    const rs = {
      tag: 'RS',
      obj,
      state: 'readable',
      reader: undefined as Any,
      storedError: undefined as Any,
      disturbed: false,
      controller: undefined as Any,
    };
    own(obj, rs);
    return rs;
  };

  const isLocked = (rs: Any): boolean => rs.reader !== undefined;
  const hasDefaultReader = (rs: Any): boolean =>
    rs.reader !== undefined && rs.reader.tag === 'RDR';
  const hasBYOBReader = (rs: Any): boolean =>
    rs.reader !== undefined && rs.reader.tag === 'RBR';
  const numReadRequests = (rs: Any): number => rs.reader.requests.length;

  const readableStreamCancel = (rs: Any, reason: Any): Promise<Any> => {
    rs.disturbed = true;
    if (rs.state === 'closed') return resolvedWith();
    if (rs.state === 'errored') return rejectedWith(rs.storedError);
    readableStreamClose(rs);
    const reader = rs.reader;
    if (reader !== undefined && reader.tag === 'RBR') {
      const requests = reader.requests;
      reader.requests = new Queue();
      while (requests.length) requests.shift().close(undefined);
    }
    const sourceCancel = rs.controller.cancelSteps(reason);
    return react(sourceCancel, noop);
  };

  const readableStreamClose = (rs: Any): void => {
    rs.state = 'closed';
    const reader = rs.reader;
    if (reader === undefined) return;
    reader.closed.resolve(undefined);
    if (reader.tag === 'RDR') {
      const requests = reader.requests;
      reader.requests = new Queue();
      while (requests.length) requests.shift().close();
    }
  };

  const readableStreamError = (rs: Any, e: Any): void => {
    rs.state = 'errored';
    rs.storedError = e;
    const reader = rs.reader;
    if (reader === undefined) return;
    reader.closed.reject(e);
    markHandled(reader.closed.promise);
    const requests = reader.requests;
    reader.requests = new Queue();
    while (requests.length) requests.shift().error(e);
  };

  const fulfillReadRequest = (rs: Any, chunk: Any, done: boolean): void => {
    const request = rs.reader.requests.shift();
    if (done) request.close();
    else request.chunk(chunk);
  };
  const fulfillReadIntoRequest = (rs: Any, chunk: Any, done: boolean) => {
    const request = rs.reader.requests.shift();
    if (done) request.close(chunk);
    else request.chunk(chunk);
  };

  // --- readers -----------------------------------------------------------------

  const readerGenericInitialize = (reader: Any, rs: Any): void => {
    reader.stream = rs;
    rs.reader = reader;
    if (rs.state === 'readable') reader.closed = deferred();
    else if (rs.state === 'closed') reader.closed = resolvedDeferred();
    else reader.closed = rejectedDeferred(rs.storedError);
  };
  const readerGenericRelease = (reader: Any): void => {
    const rs = reader.stream;
    const released = typeError('Releasing reader');
    if (rs.state === 'readable') reader.closed.reject(released);
    else reader.closed = rejectedDeferred(released);
    markHandled(reader.closed.promise);
    rs.controller.releaseSteps();
    rs.reader = undefined;
    reader.stream = undefined;
  };
  const readerRelease = (reader: Any): void => {
    readerGenericRelease(reader);
    const e = typeError('Releasing reader');
    const requests = reader.requests;
    reader.requests = new Queue();
    while (requests.length) requests.shift().error(e);
  };

  const setUpDefaultReader = (obj: Any, rs: Any): Any => {
    if (isLocked(rs)) {
      throw typeError("Failed to construct 'ReadableStreamDefaultReader': ReadableStreamDefaultReader constructor can only accept readable streams that are not yet locked to a reader");
    }
    const reader = {
      tag: 'RDR',
      obj,
      stream: undefined as Any,
      closed: undefined as Any,
      requests: new Queue<ReadRequest>(),
    };
    readerGenericInitialize(reader, rs);
    own(obj, reader);
    return reader;
  };
  const setUpBYOBReader = (obj: Any, rs: Any): Any => {
    if (isLocked(rs)) {
      throw typeError("Failed to construct 'ReadableStreamBYOBReader': ReadableStreamBYOBReader constructor can only accept readable streams that are not yet locked to a reader");
    }
    if (rs.controller.tag !== 'RBC') {
      throw typeError("Failed to construct 'ReadableStreamBYOBReader': Cannot construct a ReadableStreamBYOBReader for a stream not constructed with a byte source");
    }
    const reader = {
      tag: 'RBR',
      obj,
      stream: undefined as Any,
      closed: undefined as Any,
      requests: new Queue<ReadRequest>(),
    };
    readerGenericInitialize(reader, rs);
    own(obj, reader);
    return reader;
  };
  const acquireDefaultReader = (rs: Any): Any =>
    slotOf(new ReadableStreamDefaultReader(rs.obj));
  const acquireBYOBReader = (rs: Any): Any =>
    slotOf(new ReadableStreamBYOBReader(rs.obj));

  const defaultReaderRead = (reader: Any, request: ReadRequest): void => {
    const rs = reader.stream;
    rs.disturbed = true;
    if (rs.state === 'closed') request.close();
    else if (rs.state === 'errored') request.error(rs.storedError);
    else rs.controller.pullSteps(request);
  };
  const byobReaderRead = (
    reader: Any,
    view: ViewInfo,
    min: number,
    request: ReadRequest,
  ): void => {
    const rs = reader.stream;
    rs.disturbed = true;
    if (rs.state === 'errored') request.error(rs.storedError);
    else byteControllerPullInto(rs.controller, view, min, request);
  };

  class ReadableStreamDefaultReader {
    constructor(stream: Any) {
      const rs = slotOf(stream);
      if (!rs || rs.tag !== 'RS') {
        throw typeError("Failed to construct 'ReadableStreamDefaultReader': parameter 1 is not of type 'ReadableStream'.");
      }
      setUpDefaultReader(this, rs);
    }
    get closed(): Promise<Any> {
      const r = slotOf(this);
      if (!r || r.tag !== 'RDR') return rejectedWith(illegal());
      return r.closed.promise;
    }
    cancel(reason: Any = undefined): Promise<Any> {
      const r = slotOf(this);
      if (!r || r.tag !== 'RDR') return rejectedWith(illegal());
      if (r.stream === undefined) {
        return rejectedWith(typeError('This readable stream reader has been released and cannot be used to cancel its previous owner stream'));
      }
      return readableStreamCancel(r.stream, reason);
    }
    read(): Promise<Any> {
      const r = slotOf(this);
      if (!r || r.tag !== 'RDR') return rejectedWith(illegal());
      if (r.stream === undefined) {
        return rejectedWith(typeError('This readable stream reader has been released and cannot be used to read from its previous owner stream'));
      }
      const d = deferred();
      defaultReaderRead(r, {
        chunk: (value) => d.resolve({ value, done: false }),
        close: () => d.resolve({ value: undefined, done: true }),
        error: (e) => d.reject(e),
      });
      return d.promise;
    }
    releaseLock(): void {
      const r = brand(this, 'RDR');
      if (r.stream === undefined) return;
      readerRelease(r);
    }
  }

  class ReadableStreamBYOBReader {
    constructor(stream: Any) {
      const rs = slotOf(stream);
      if (!rs || rs.tag !== 'RS') {
        throw typeError("Failed to construct 'ReadableStreamBYOBReader': parameter 1 is not of type 'ReadableStream'.");
      }
      setUpBYOBReader(this, rs);
    }
    get closed(): Promise<Any> {
      const r = slotOf(this);
      if (!r || r.tag !== 'RBR') return rejectedWith(illegal());
      return r.closed.promise;
    }
    cancel(reason: Any = undefined): Promise<Any> {
      const r = slotOf(this);
      if (!r || r.tag !== 'RBR') return rejectedWith(illegal());
      if (r.stream === undefined) {
        return rejectedWith(typeError('This readable stream reader has been released and cannot be used to cancel its previous owner stream'));
      }
      return readableStreamCancel(r.stream, reason);
    }
    read(view: Any, options: Any = undefined): Promise<Any> {
      const r = slotOf(this);
      if (!r || r.tag !== 'RBR') return rejectedWith(illegal());
      let info: ViewInfo;
      let min = 1;
      try {
        info = viewArgument(view, "Failed to execute 'read' on 'ReadableStreamBYOBReader'");
        const d = dictionary(options, 'ReadableStreamBYOBReaderReadOptions');
        if (d && d.min !== undefined) {
          min = enforceRange(d.min, "Failed to read the 'min' property from 'ReadableStreamBYOBReaderReadOptions'");
        }
      } catch (e) {
        return rejectedWith(e);
      }
      if (info.byteLength === 0) {
        return rejectedWith(typeError('view must have non-zero byteLength'));
      }
      if (bufferByteLength(info.buffer) === 0) {
        if (isDetached(info.buffer)) {
          return rejectedWith(typeError("view's buffer has been detached"));
        }
        return rejectedWith(typeError("view's buffer must have non-zero byteLength"));
      }
      if (isDetached(info.buffer)) {
        return rejectedWith(typeError("view's buffer has been detached"));
      }
      if (min === 0) {
        return rejectedWith(typeError('options.min must be greater than 0'));
      }
      if (info.ctor !== DV) {
        if (min > info.length) {
          return rejectedWith(rangeError('options.min must be less than or equal to view\'s length'));
        }
      } else if (min > info.byteLength) {
        return rejectedWith(rangeError("options.min must be less than or equal to view's byteLength"));
      }
      if (r.stream === undefined) {
        return rejectedWith(typeError('This readable stream reader has been released and cannot be used to read from its previous owner stream'));
      }
      const d = deferred();
      byobReaderRead(r, info, min, {
        chunk: (value) => d.resolve({ value, done: false }),
        close: (value) => d.resolve({ value, done: true }),
        error: (e) => d.reject(e),
      });
      return d.promise;
    }
    releaseLock(): void {
      const r = brand(this, 'RBR');
      if (r.stream === undefined) return;
      readerRelease(r);
    }
  }

  // --- the default controller -----------------------------------------------------

  const defaultControllerCanCloseOrEnqueue = (c: Any): boolean =>
    !c.closeRequested && c.stream.state === 'readable';
  const defaultControllerDesiredSize = (c: Any): number | null => {
    const state = c.stream.state;
    if (state === 'errored') return null;
    if (state === 'closed') return 0;
    return c.strategyHWM - c.queueTotalSize;
  };
  const defaultControllerShouldCallPull = (c: Any): boolean => {
    const rs = c.stream;
    if (!defaultControllerCanCloseOrEnqueue(c)) return false;
    if (!c.started) return false;
    if (isLocked(rs) && numReadRequests(rs) > 0) return true;
    const desired = defaultControllerDesiredSize(c);
    return desired! > 0;
  };
  const defaultControllerCallPullIfNeeded = (c: Any): void => {
    if (!defaultControllerShouldCallPull(c)) return;
    if (c.pulling) {
      c.pullAgain = true;
      return;
    }
    c.pulling = true;
    upon(
      c.pullAlgorithm(),
      () => {
        c.pulling = false;
        if (c.pullAgain) {
          c.pullAgain = false;
          defaultControllerCallPullIfNeeded(c);
        }
      },
      (e: Any) => defaultControllerError(c, e),
    );
  };
  const defaultControllerClearAlgorithms = (c: Any): void => {
    c.pullAlgorithm = undefined;
    c.cancelAlgorithm = undefined;
    c.strategySizeAlgorithm = undefined;
  };
  const defaultControllerClose = (c: Any): void => {
    if (!defaultControllerCanCloseOrEnqueue(c)) return;
    c.closeRequested = true;
    if (c.queue.length === 0) {
      defaultControllerClearAlgorithms(c);
      readableStreamClose(c.stream);
    }
  };
  const defaultControllerEnqueue = (c: Any, chunk: Any): void => {
    if (!defaultControllerCanCloseOrEnqueue(c)) return;
    const rs = c.stream;
    if (isLocked(rs) && numReadRequests(rs) > 0) {
      fulfillReadRequest(rs, chunk, false);
    } else {
      let size: number;
      try {
        size = c.strategySizeAlgorithm(chunk);
      } catch (e) {
        defaultControllerError(c, e);
        throw e;
      }
      try {
        enqueueValueWithSize(c, chunk, size);
      } catch (e) {
        defaultControllerError(c, e);
        throw e;
      }
    }
    defaultControllerCallPullIfNeeded(c);
  };
  const defaultControllerError = (c: Any, e: Any): void => {
    const rs = c.stream;
    if (rs.state !== 'readable') return;
    resetQueue(c);
    defaultControllerClearAlgorithms(c);
    readableStreamError(rs, e);
  };
  const defaultControllerHasBackpressure = (c: Any): boolean =>
    !defaultControllerShouldCallPull(c);

  const setUpDefaultController = (
    rs: Any,
    obj: Any,
    start: () => Any,
    pull: () => Promise<Any>,
    cancel: (r: Any) => Promise<Any>,
    hwm: number,
    size: (chunk: Any) => number,
  ): void => {
    const c: Any = {
      tag: 'RDC',
      obj,
      stream: rs,
      queue: new Queue(),
      queueTotalSize: 0,
      started: false,
      closeRequested: false,
      pullAgain: false,
      pulling: false,
      strategySizeAlgorithm: size,
      strategyHWM: hwm,
      pullAlgorithm: pull,
      cancelAlgorithm: cancel,
    };
    c.cancelSteps = (reason: Any) => {
      resetQueue(c);
      const result = c.cancelAlgorithm(reason);
      defaultControllerClearAlgorithms(c);
      return result;
    };
    c.pullSteps = (request: ReadRequest) => {
      if (c.queue.length > 0) {
        const chunk = dequeueValue(c);
        if (c.closeRequested && c.queue.length === 0) {
          defaultControllerClearAlgorithms(c);
          readableStreamClose(rs);
        } else defaultControllerCallPullIfNeeded(c);
        request.chunk(chunk);
      } else {
        rs.reader.requests.push(request);
        defaultControllerCallPullIfNeeded(c);
      }
    };
    c.releaseSteps = noop;
    own(obj, c);
    rs.controller = c;
    const startResult = start();
    upon(
      resolvedWith(startResult),
      () => {
        c.started = true;
        defaultControllerCallPullIfNeeded(c);
      },
      (r: Any) => defaultControllerError(c, r),
    );
  };

  class ReadableStreamDefaultController {
    constructor() {
      throw illegalConstructor();
    }
    get desiredSize(): number | null {
      return defaultControllerDesiredSize(brand(this, 'RDC'));
    }
    close(): void {
      const c = brand(this, 'RDC');
      if (!defaultControllerCanCloseOrEnqueue(c)) {
        throw typeError("Failed to execute 'close' on 'ReadableStreamDefaultController': Cannot close a readable stream that has already been requested to be closed");
      }
      defaultControllerClose(c);
    }
    enqueue(chunk: Any = undefined): void {
      const c = brand(this, 'RDC');
      if (!defaultControllerCanCloseOrEnqueue(c)) {
        throw typeError("Failed to execute 'enqueue' on 'ReadableStreamDefaultController': Cannot enqueue a chunk into a readable stream that is closed or has been requested to be closed");
      }
      defaultControllerEnqueue(c, chunk);
    }
    error(e: Any = undefined): void {
      defaultControllerError(brand(this, 'RDC'), e);
    }
  }
  /** An object of an interface with no constructor, made here. */
  const made = (Interface: Any): Any => objectCreate(Interface.prototype);

  // --- the byte controller ------------------------------------------------------

  interface PullInto {
    buffer: Any;
    bufferByteLength: number;
    byteOffset: number;
    byteLength: number;
    bytesFilled: number;
    minimumFill: number;
    elementSize: number;
    viewConstructor: Any;
    readerType: 'default' | 'byob' | 'none';
  }

  const byteControllerDesiredSize = (c: Any): number | null => {
    const state = c.stream.state;
    if (state === 'errored') return null;
    if (state === 'closed') return 0;
    return c.strategyHWM - c.queueTotalSize;
  };
  const byteControllerShouldCallPull = (c: Any): boolean => {
    const rs = c.stream;
    if (rs.state !== 'readable') return false;
    if (c.closeRequested) return false;
    if (!c.started) return false;
    if (hasDefaultReader(rs) && numReadRequests(rs) > 0) return true;
    if (hasBYOBReader(rs) && numReadRequests(rs) > 0) return true;
    return byteControllerDesiredSize(c)! > 0;
  };
  const byteControllerCallPullIfNeeded = (c: Any): void => {
    if (!byteControllerShouldCallPull(c)) return;
    if (c.pulling) {
      c.pullAgain = true;
      return;
    }
    c.pulling = true;
    upon(
      c.pullAlgorithm(),
      () => {
        c.pulling = false;
        if (c.pullAgain) {
          c.pullAgain = false;
          byteControllerCallPullIfNeeded(c);
        }
      },
      (e: Any) => byteControllerError(c, e),
    );
  };
  const byteControllerClearAlgorithms = (c: Any): void => {
    c.pullAlgorithm = undefined;
    c.cancelAlgorithm = undefined;
  };
  const byteControllerInvalidateBYOBRequest = (c: Any): void => {
    if (c.byobRequest === null) return;
    c.byobRequest.controller = undefined;
    c.byobRequest.view = null;
    c.byobRequest = null;
  };
  const byteControllerClearPendingPullIntos = (c: Any): void => {
    byteControllerInvalidateBYOBRequest(c);
    c.pendingPullIntos = new Queue();
  };
  const byteControllerError = (c: Any, e: Any): void => {
    const rs = c.stream;
    if (rs.state !== 'readable') return;
    byteControllerClearPendingPullIntos(c);
    resetQueue(c);
    byteControllerClearAlgorithms(c);
    readableStreamError(rs, e);
  };
  const byteControllerClose = (c: Any): void => {
    const rs = c.stream;
    if (c.closeRequested || rs.state !== 'readable') return;
    if (c.queueTotalSize > 0) {
      c.closeRequested = true;
      return;
    }
    if (c.pendingPullIntos.length > 0) {
      const first = c.pendingPullIntos.peek();
      if (first.bytesFilled % first.elementSize !== 0) {
        const e = typeError('Insufficient bytes to fill elements in the given buffer');
        byteControllerError(c, e);
        throw e;
      }
    }
    byteControllerClearAlgorithms(c);
    readableStreamClose(rs);
  };
  const convertPullIntoDescriptor = (d: PullInto): Any => {
    const buffer = transferBuffer(d.buffer);
    return new d.viewConstructor(
      buffer,
      d.byteOffset,
      d.bytesFilled / d.elementSize,
    );
  };
  const commitPullIntoDescriptor = (rs: Any, d: PullInto): void => {
    let done = false;
    if (rs.state === 'closed') done = true;
    const filled = convertPullIntoDescriptor(d);
    if (d.readerType === 'default') fulfillReadRequest(rs, filled, done);
    else fulfillReadIntoRequest(rs, filled, done);
  };
  const byteControllerEnqueueChunkToQueue = (
    c: Any,
    buffer: Any,
    byteOffset: number,
    byteLength: number,
  ): void => {
    c.queue.push({ buffer, byteOffset, byteLength });
    c.queueTotalSize += byteLength;
  };
  const byteControllerEnqueueClonedChunkToQueue = (
    c: Any,
    buffer: Any,
    byteOffset: number,
    byteLength: number,
  ): void => {
    let clone: Any;
    try {
      clone = cloneBuffer(buffer, byteOffset, byteLength);
    } catch (e) {
      byteControllerError(c, e);
      throw e;
    }
    byteControllerEnqueueChunkToQueue(c, clone, 0, byteLength);
  };
  const byteControllerShiftPendingPullInto = (c: Any): PullInto =>
    c.pendingPullIntos.shift();
  const byteControllerEnqueueDetachedPullIntoToQueue = (
    c: Any,
    d: PullInto,
  ): void => {
    if (d.bytesFilled > 0) {
      byteControllerEnqueueClonedChunkToQueue(
        c,
        d.buffer,
        d.byteOffset,
        d.bytesFilled,
      );
    }
    byteControllerShiftPendingPullInto(c);
  };
  const byteControllerFillHeadPullIntoDescriptor = (
    _c: Any,
    size: number,
    d: PullInto,
  ): void => {
    d.bytesFilled += size;
  };
  const byteControllerFillPullIntoDescriptorFromQueue = (
    c: Any,
    d: PullInto,
  ): boolean => {
    const maxBytesToCopy = mathMin(
      c.queueTotalSize,
      d.byteLength - d.bytesFilled,
    );
    const maxBytesFilled = d.bytesFilled + maxBytesToCopy;
    let totalBytesToCopyRemaining = maxBytesToCopy;
    let ready = false;
    const remainderBytes = maxBytesFilled % d.elementSize;
    const maxAlignedBytes = maxBytesFilled - remainderBytes;
    if (maxAlignedBytes >= d.minimumFill) {
      totalBytesToCopyRemaining = maxAlignedBytes - d.bytesFilled;
      ready = true;
    }
    const queue = c.queue;
    while (totalBytesToCopyRemaining > 0) {
      const head = queue.peek();
      const bytesToCopy = mathMin(totalBytesToCopyRemaining, head.byteLength);
      const destStart = d.byteOffset + d.bytesFilled;
      copyBytes(d.buffer, destStart, head.buffer, head.byteOffset, bytesToCopy);
      if (head.byteLength === bytesToCopy) queue.shift();
      else {
        head.byteOffset += bytesToCopy;
        head.byteLength -= bytesToCopy;
      }
      c.queueTotalSize -= bytesToCopy;
      byteControllerFillHeadPullIntoDescriptor(c, bytesToCopy, d);
      totalBytesToCopyRemaining -= bytesToCopy;
    }
    return ready;
  };
  const byteControllerFillReadRequestFromQueue = (
    c: Any,
    request: ReadRequest,
  ): void => {
    const entry = c.queue.shift();
    c.queueTotalSize -= entry.byteLength;
    byteControllerHandleQueueDrain(c);
    request.chunk(new U8(entry.buffer, entry.byteOffset, entry.byteLength));
  };
  const byteControllerHandleQueueDrain = (c: Any): void => {
    if (c.queueTotalSize === 0 && c.closeRequested) {
      byteControllerClearAlgorithms(c);
      readableStreamClose(c.stream);
    } else byteControllerCallPullIfNeeded(c);
  };
  const byteControllerProcessPullIntoDescriptorsUsingQueue = (
    c: Any,
  ): PullInto[] => {
    const filled: PullInto[] = [];
    while (c.pendingPullIntos.length > 0) {
      if (c.queueTotalSize === 0) break;
      const d = c.pendingPullIntos.peek();
      if (byteControllerFillPullIntoDescriptorFromQueue(c, d)) {
        byteControllerShiftPendingPullInto(c);
        filled[filled.length] = d;
      }
    }
    return filled;
  };
  const byteControllerProcessReadRequestsUsingQueue = (c: Any): void => {
    const reader = c.stream.reader;
    while (reader.requests.length > 0) {
      if (c.queueTotalSize === 0) return;
      const request = reader.requests.shift();
      byteControllerFillReadRequestFromQueue(c, request);
    }
  };
  const byteControllerEnqueue = (c: Any, chunk: ViewInfo): void => {
    const rs = c.stream;
    if (c.closeRequested || rs.state !== 'readable') return;
    const { buffer, byteOffset, byteLength } = chunk;
    if (isDetached(buffer)) {
      throw typeError("chunk's buffer is detached and so cannot be enqueued");
    }
    const transferred = transferBuffer(buffer);
    if (c.pendingPullIntos.length > 0) {
      const first = c.pendingPullIntos.peek();
      if (isDetached(first.buffer)) {
        throw typeError("The BYOB request's buffer has been detached and so cannot be filled with an enqueued chunk");
      }
      byteControllerInvalidateBYOBRequest(c);
      first.buffer = transferBuffer(first.buffer);
      if (first.readerType === 'none') {
        byteControllerEnqueueDetachedPullIntoToQueue(c, first);
      }
    }
    if (hasDefaultReader(rs)) {
      byteControllerProcessReadRequestsUsingQueue(c);
      if (numReadRequests(rs) === 0) {
        byteControllerEnqueueChunkToQueue(c, transferred, byteOffset, byteLength);
      } else {
        if (c.pendingPullIntos.length > 0) {
          byteControllerShiftPendingPullInto(c);
        }
        fulfillReadRequest(rs, new U8(transferred, byteOffset, byteLength), false);
      }
    } else if (hasBYOBReader(rs)) {
      byteControllerEnqueueChunkToQueue(c, transferred, byteOffset, byteLength);
      const filled = byteControllerProcessPullIntoDescriptorsUsingQueue(c);
      for (let i = 0; i < filled.length; i += 1) {
        commitPullIntoDescriptor(rs, filled[i]);
      }
    } else {
      byteControllerEnqueueChunkToQueue(c, transferred, byteOffset, byteLength);
    }
    byteControllerCallPullIfNeeded(c);
  };
  const byteControllerGetBYOBRequest = (c: Any): Any => {
    if (c.byobRequest === null && c.pendingPullIntos.length > 0) {
      const first = c.pendingPullIntos.peek();
      const view = new U8(
        first.buffer,
        first.byteOffset + first.bytesFilled,
        first.byteLength - first.bytesFilled,
      );
      const obj = made(ReadableStreamBYOBRequest);
      const request = { tag: 'BYOB', obj, controller: c, view };
      own(obj, request);
      c.byobRequest = request;
    }
    return c.byobRequest;
  };
  const byteControllerPullInto = (
    c: Any,
    view: ViewInfo,
    min: number,
    request: ReadRequest,
  ): void => {
    const rs = c.stream;
    const elementSize = view.elementSize;
    const ctor = view.ctor;
    const minimumFill = min * elementSize;
    const { byteOffset, byteLength } = view;
    let buffer: Any;
    try {
      buffer = transferBuffer(view.buffer);
    } catch (e) {
      request.error(e);
      return;
    }
    const d: PullInto = {
      buffer,
      bufferByteLength: bufferByteLength(buffer),
      byteOffset,
      byteLength,
      bytesFilled: 0,
      minimumFill,
      elementSize,
      viewConstructor: ctor,
      readerType: 'byob',
    };
    if (c.pendingPullIntos.length > 0) {
      c.pendingPullIntos.push(d);
      rs.reader.requests.push(request);
      return;
    }
    if (rs.state === 'closed') {
      request.close(new ctor(d.buffer, d.byteOffset, 0));
      return;
    }
    if (c.queueTotalSize > 0) {
      if (byteControllerFillPullIntoDescriptorFromQueue(c, d)) {
        const filled = convertPullIntoDescriptor(d);
        byteControllerHandleQueueDrain(c);
        request.chunk(filled);
        return;
      }
      if (c.closeRequested) {
        const e = typeError('Insufficient bytes to fill elements in the given buffer');
        byteControllerError(c, e);
        request.error(e);
        return;
      }
    }
    c.pendingPullIntos.push(d);
    rs.reader.requests.push(request);
    byteControllerCallPullIfNeeded(c);
  };
  const byteControllerRespondInClosedState = (c: Any, first: PullInto) => {
    if (first.readerType === 'none') byteControllerShiftPendingPullInto(c);
    const rs = c.stream;
    if (hasBYOBReader(rs)) {
      const filled: PullInto[] = [];
      while (filled.length < numReadRequests(rs)) {
        filled[filled.length] = byteControllerShiftPendingPullInto(c);
      }
      for (let i = 0; i < filled.length; i += 1) {
        commitPullIntoDescriptor(rs, filled[i]);
      }
    }
  };
  const byteControllerRespondInReadableState = (
    c: Any,
    bytesWritten: number,
    d: PullInto,
  ): void => {
    byteControllerFillHeadPullIntoDescriptor(c, bytesWritten, d);
    if (d.readerType === 'none') {
      byteControllerEnqueueDetachedPullIntoToQueue(c, d);
      const filled = byteControllerProcessPullIntoDescriptorsUsingQueue(c);
      for (let i = 0; i < filled.length; i += 1) {
        commitPullIntoDescriptor(c.stream, filled[i]);
      }
      return;
    }
    if (d.bytesFilled < d.minimumFill) return;
    byteControllerShiftPendingPullInto(c);
    const remainder = d.bytesFilled % d.elementSize;
    if (remainder > 0) {
      const end = d.byteOffset + d.bytesFilled;
      byteControllerEnqueueClonedChunkToQueue(c, d.buffer, end - remainder, remainder);
    }
    d.bytesFilled -= remainder;
    const filled = byteControllerProcessPullIntoDescriptorsUsingQueue(c);
    commitPullIntoDescriptor(c.stream, d);
    for (let i = 0; i < filled.length; i += 1) {
      commitPullIntoDescriptor(c.stream, filled[i]);
    }
  };
  const byteControllerRespondInternal = (c: Any, bytesWritten: number) => {
    const first = c.pendingPullIntos.peek();
    byteControllerInvalidateBYOBRequest(c);
    if (c.stream.state === 'closed') {
      byteControllerRespondInClosedState(c, first);
    } else byteControllerRespondInReadableState(c, bytesWritten, first);
    byteControllerCallPullIfNeeded(c);
  };
  const byteControllerRespond = (c: Any, bytesWritten: number): void => {
    const first = c.pendingPullIntos.peek();
    const state = c.stream.state;
    if (state === 'closed') {
      if (bytesWritten !== 0) {
        throw typeError('bytesWritten must be 0 when calling respond() on a closed stream');
      }
    } else {
      if (bytesWritten === 0) {
        throw typeError('bytesWritten must be greater than 0 when calling respond() on a readable stream');
      }
      if (first.bytesFilled + bytesWritten > first.byteLength) {
        throw rangeError('bytesWritten out of range');
      }
    }
    first.buffer = transferBuffer(first.buffer);
    byteControllerRespondInternal(c, bytesWritten);
  };
  const byteControllerRespondWithNewView = (c: Any, view: ViewInfo) => {
    const first = c.pendingPullIntos.peek();
    const state = c.stream.state;
    if (state === 'closed') {
      if (view.byteLength !== 0) {
        throw typeError("The view's length must be 0 when calling respondWithNewView() on a closed stream");
      }
    } else if (view.byteLength === 0) {
      throw typeError("The view's length must be greater than 0 when calling respondWithNewView() on a readable stream");
    }
    if (first.byteOffset + first.bytesFilled !== view.byteOffset) {
      throw rangeError('The region specified by view does not match byobRequest');
    }
    if (first.bufferByteLength !== bufferByteLength(view.buffer)) {
      throw rangeError('The buffer of view has different capacity than byobRequest');
    }
    if (first.bytesFilled + view.byteLength > first.byteLength) {
      throw rangeError('The region specified by view is larger than byobRequest');
    }
    const viewByteLength = view.byteLength;
    first.buffer = transferBuffer(view.buffer);
    byteControllerRespondInternal(c, viewByteLength);
  };

  const setUpByteController = (
    rs: Any,
    obj: Any,
    start: () => Any,
    pull: () => Promise<Any>,
    cancel: (r: Any) => Promise<Any>,
    hwm: number,
    autoAllocateChunkSize: number | undefined,
  ): void => {
    const c: Any = {
      tag: 'RBC',
      obj,
      stream: rs,
      pullAgain: false,
      pulling: false,
      byobRequest: null,
      queue: new Queue(),
      queueTotalSize: 0,
      closeRequested: false,
      started: false,
      strategyHWM: hwm,
      pullAlgorithm: pull,
      cancelAlgorithm: cancel,
      autoAllocateChunkSize,
      pendingPullIntos: new Queue<PullInto>(),
    };
    c.cancelSteps = (reason: Any) => {
      byteControllerClearPendingPullIntos(c);
      resetQueue(c);
      const result = c.cancelAlgorithm(reason);
      byteControllerClearAlgorithms(c);
      return result;
    };
    c.pullSteps = (request: ReadRequest) => {
      if (c.queueTotalSize > 0) {
        byteControllerFillReadRequestFromQueue(c, request);
        return;
      }
      const auto = c.autoAllocateChunkSize;
      if (auto !== undefined) {
        let buffer: Any;
        try {
          buffer = new AB(auto);
        } catch (e) {
          request.error(e);
          return;
        }
        c.pendingPullIntos.push({
          buffer,
          bufferByteLength: auto,
          byteOffset: 0,
          byteLength: auto,
          bytesFilled: 0,
          minimumFill: 1,
          elementSize: 1,
          viewConstructor: U8,
          readerType: 'default',
        });
      }
      rs.reader.requests.push(request);
      byteControllerCallPullIfNeeded(c);
    };
    c.releaseSteps = () => {
      if (c.pendingPullIntos.length > 0) {
        const first = c.pendingPullIntos.peek();
        first.readerType = 'none';
        c.pendingPullIntos = new Queue();
        c.pendingPullIntos.push(first);
      }
    };
    own(obj, c);
    rs.controller = c;
    const startResult = start();
    upon(
      resolvedWith(startResult),
      () => {
        c.started = true;
        byteControllerCallPullIfNeeded(c);
      },
      (r: Any) => byteControllerError(c, r),
    );
  };

  class ReadableByteStreamController {
    constructor() {
      throw illegalConstructor();
    }
    get byobRequest(): Any {
      const r = byteControllerGetBYOBRequest(brand(this, 'RBC'));
      return r === null ? null : r.obj;
    }
    get desiredSize(): number | null {
      return byteControllerDesiredSize(brand(this, 'RBC'));
    }
    close(): void {
      const c = brand(this, 'RBC');
      if (c.closeRequested) {
        throw typeError("Failed to execute 'close' on 'ReadableByteStreamController': The stream has already been closed.");
      }
      if (c.stream.state !== 'readable') {
        throw typeError("Failed to execute 'close' on 'ReadableByteStreamController': The stream is not in the readable state and cannot be closed");
      }
      byteControllerClose(c);
    }
    enqueue(chunk: Any): void {
      const c = brand(this, 'RBC');
      const info = viewArgument(chunk, "Failed to execute 'enqueue' on 'ReadableByteStreamController'");
      if (info.byteLength === 0) {
        throw typeError("Failed to execute 'enqueue' on 'ReadableByteStreamController': chunk must have non-zero byteLength");
      }
      if (bufferByteLength(info.buffer) === 0) {
        throw typeError("Failed to execute 'enqueue' on 'ReadableByteStreamController': chunk's buffer must have non-zero byteLength");
      }
      if (c.closeRequested) {
        throw typeError("Failed to execute 'enqueue' on 'ReadableByteStreamController': stream is closed or draining");
      }
      if (c.stream.state !== 'readable') {
        throw typeError("Failed to execute 'enqueue' on 'ReadableByteStreamController': The stream is not in the readable state and cannot be enqueued to");
      }
      byteControllerEnqueue(c, info);
    }
    error(e: Any = undefined): void {
      byteControllerError(brand(this, 'RBC'), e);
    }
  }

  class ReadableStreamBYOBRequest {
    constructor() {
      throw illegalConstructor();
    }
    get view(): Any {
      return brand(this, 'BYOB').view;
    }
    respond(bytesWritten: Any): void {
      const r = brand(this, 'BYOB');
      const n = enforceRange(bytesWritten, "Failed to execute 'respond' on 'ReadableStreamBYOBRequest'");
      if (r.controller === undefined) {
        throw typeError('This BYOB request has been invalidated');
      }
      if (isDetached(viewInfo(r.view).buffer)) {
        throw typeError('The BYOB request\'s buffer has been detached and so cannot be used as a response');
      }
      byteControllerRespond(r.controller, n);
    }
    respondWithNewView(view: Any): void {
      const r = brand(this, 'BYOB');
      const info = viewArgument(view, "Failed to execute 'respondWithNewView' on 'ReadableStreamBYOBRequest'");
      if (r.controller === undefined) {
        throw typeError('This BYOB request has been invalidated');
      }
      if (isDetached(info.buffer)) {
        throw typeError("The given view's buffer has been detached and so cannot be used as a response");
      }
      byteControllerRespondWithNewView(r.controller, info);
    }
  }

  // --- making a readable stream ------------------------------------------------

  const sourceDictionary = (source: Any): Any => {
    const context = "Failed to construct 'ReadableStream'";
    if (source === null) {
      return {
        autoAllocateChunkSize: undefined,
        cancel: undefined,
        pull: undefined,
        start: undefined,
        type: undefined,
      };
    }
    const rawAuto = source.autoAllocateChunkSize;
    const autoAllocateChunkSize =
      rawAuto === undefined ? undefined : enforceRange(rawAuto, context);
    const cancel = callbackMember(source, 'cancel', context);
    const pull = callbackMember(source, 'pull', context);
    const start = callbackMember(source, 'start', context);
    const rawType = source.type;
    let type: string | undefined;
    if (rawType !== undefined) {
      type = `${rawType}`;
      if (type !== 'bytes') {
        throw typeError(`${context}: The provided value '${type}' is not a valid enum value of type ReadableStreamType.`);
      }
    }
    return { autoAllocateChunkSize, cancel, pull, start, type };
  };

  const setUpDefaultFromSource = (
    rs: Any,
    source: Any,
    d: Any,
    hwm: number,
    size: (chunk: Any) => number,
  ): void => {
    const obj = made(ReadableStreamDefaultController);
    const start = d.start
      ? () => apply(d.start, source, [obj])
      : () => undefined;
    const pull = d.pull
      ? () => promiseCall(d.pull, source, [obj])
      : () => resolvedWith();
    const cancel = d.cancel
      ? (reason: Any) => promiseCall(d.cancel, source, [reason])
      : () => resolvedWith();
    setUpDefaultController(rs, obj, start, pull, cancel, hwm, size);
  };
  const setUpByteFromSource = (
    rs: Any,
    source: Any,
    d: Any,
    hwm: number,
  ): void => {
    const obj = made(ReadableByteStreamController);
    const start = d.start
      ? () => apply(d.start, source, [obj])
      : () => undefined;
    const pull = d.pull
      ? () => promiseCall(d.pull, source, [obj])
      : () => resolvedWith();
    const cancel = d.cancel
      ? (reason: Any) => promiseCall(d.cancel, source, [reason])
      : () => resolvedWith();
    if (d.autoAllocateChunkSize === 0) {
      throw typeError("Failed to construct 'ReadableStream': autoAllocateChunkSize must be greater than 0");
    }
    setUpByteController(rs, obj, start, pull, cancel, hwm, d.autoAllocateChunkSize);
  };

  const createReadableStream = (
    start: () => Any,
    pull: () => Promise<Any>,
    cancel: (r: Any) => Promise<Any>,
    hwm = 1,
    size: (chunk: Any) => number = () => 1,
    into?: Any,
  ): Any => {
    const obj = into ?? new ReadableStream(INTERNAL);
    const rs = slotOf(obj);
    setUpDefaultController(
      rs,
      made(ReadableStreamDefaultController),
      start,
      pull,
      cancel,
      hwm,
      size,
    );
    return rs;
  };
  const createReadableByteStream = (
    start: () => Any,
    pull: () => Promise<Any>,
    cancel: (r: Any) => Promise<Any>,
    hwm = 0,
    into?: Any,
  ): Any => {
    const obj = into ?? new ReadableStream(INTERNAL);
    const rs = slotOf(obj);
    setUpByteController(
      rs,
      made(ReadableByteStreamController),
      start,
      pull,
      cancel,
      hwm,
      undefined,
    );
    return rs;
  };

  // --- tee ---------------------------------------------------------------------

  const defaultTee = (rs: Any): [Any, Any] => {
    const reader = acquireDefaultReader(rs);
    let reading = false;
    let readAgain = false;
    let canceled1 = false;
    let canceled2 = false;
    let reason1: Any;
    let reason2: Any;
    let branch1: Any;
    let branch2: Any;
    const cancelPromise = deferred();
    const pull = (): Promise<Any> => {
      if (reading) {
        readAgain = true;
        return resolvedWith();
      }
      reading = true;
      defaultReaderRead(reader, {
        chunk: (chunk) => {
          microtask(() => {
            readAgain = false;
            if (!canceled1) defaultControllerEnqueue(branch1.controller, chunk);
            if (!canceled2) defaultControllerEnqueue(branch2.controller, chunk);
            reading = false;
            if (readAgain) pull();
          });
        },
        close: () => {
          reading = false;
          if (!canceled1) defaultControllerClose(branch1.controller);
          if (!canceled2) defaultControllerClose(branch2.controller);
          if (!canceled1 || !canceled2) cancelPromise.resolve(undefined);
        },
        error: () => {
          reading = false;
        },
      });
      return resolvedWith();
    };
    const cancel1 = (reason: Any): Promise<Any> => {
      canceled1 = true;
      reason1 = reason;
      if (canceled2) {
        cancelPromise.resolve(readableStreamCancel(rs, [reason1, reason2]));
      }
      return cancelPromise.promise;
    };
    const cancel2 = (reason: Any): Promise<Any> => {
      canceled2 = true;
      reason2 = reason;
      if (canceled1) {
        cancelPromise.resolve(readableStreamCancel(rs, [reason1, reason2]));
      }
      return cancelPromise.promise;
    };
    const start = () => undefined;
    branch1 = createReadableStream(start, pull, cancel1);
    branch2 = createReadableStream(start, pull, cancel2);
    upon(reader.closed.promise, undefined, (r: Any) => {
      defaultControllerError(branch1.controller, r);
      defaultControllerError(branch2.controller, r);
      if (!canceled1 || !canceled2) cancelPromise.resolve(undefined);
    });
    return [branch1, branch2];
  };

  const cloneAsUint8Array = (view: Any): Any => {
    const info = viewInfo(view);
    return new U8(cloneBuffer(info.buffer, info.byteOffset, info.byteLength));
  };

  const byteTee = (rs: Any): [Any, Any] => {
    let reader = acquireDefaultReader(rs);
    let reading = false;
    let readAgainForBranch1 = false;
    let readAgainForBranch2 = false;
    let canceled1 = false;
    let canceled2 = false;
    let reason1: Any;
    let reason2: Any;
    let branch1: Any;
    let branch2: Any;
    const cancelPromise = deferred();
    const forwardReaderError = (thisReader: Any): void => {
      upon(thisReader.closed.promise, undefined, (r: Any) => {
        if (thisReader !== reader) return;
        byteControllerError(branch1.controller, r);
        byteControllerError(branch2.controller, r);
        if (!canceled1 || !canceled2) cancelPromise.resolve(undefined);
      });
    };
    const pullWithDefaultReader = (): void => {
      if (reader.tag === 'RBR') {
        readerRelease(reader);
        reader = acquireDefaultReader(rs);
        forwardReaderError(reader);
      }
      defaultReaderRead(reader, {
        chunk: (chunk) => {
          microtask(() => {
            readAgainForBranch1 = false;
            readAgainForBranch2 = false;
            const chunk1 = chunk;
            let chunk2 = chunk;
            if (!canceled1 && !canceled2) {
              try {
                chunk2 = cloneAsUint8Array(chunk);
              } catch (e) {
                byteControllerError(branch1.controller, e);
                byteControllerError(branch2.controller, e);
                cancelPromise.resolve(readableStreamCancel(rs, e));
                return;
              }
            }
            if (!canceled1) {
              byteControllerEnqueue(branch1.controller, viewInfo(chunk1));
            }
            if (!canceled2) {
              byteControllerEnqueue(branch2.controller, viewInfo(chunk2));
            }
            reading = false;
            if (readAgainForBranch1) pull1();
            else if (readAgainForBranch2) pull2();
          });
        },
        close: () => {
          reading = false;
          if (!canceled1) byteControllerClose(branch1.controller);
          if (!canceled2) byteControllerClose(branch2.controller);
          if (branch1.controller.pendingPullIntos.length > 0) {
            byteControllerRespond(branch1.controller, 0);
          }
          if (branch2.controller.pendingPullIntos.length > 0) {
            byteControllerRespond(branch2.controller, 0);
          }
          if (!canceled1 || !canceled2) cancelPromise.resolve(undefined);
        },
        error: () => {
          reading = false;
        },
      });
    };
    const pullWithBYOBReader = (view: Any, forBranch2: boolean): void => {
      if (reader.tag === 'RDR') {
        readerRelease(reader);
        reader = acquireBYOBReader(rs);
        forwardReaderError(reader);
      }
      const byobBranch = forBranch2 ? branch2 : branch1;
      const otherBranch = forBranch2 ? branch1 : branch2;
      byobReaderRead(reader, viewInfo(view), 1, {
        chunk: (chunk) => {
          microtask(() => {
            readAgainForBranch1 = false;
            readAgainForBranch2 = false;
            const byobCanceled = forBranch2 ? canceled2 : canceled1;
            const otherCanceled = forBranch2 ? canceled1 : canceled2;
            if (!otherCanceled) {
              let cloned: Any;
              try {
                cloned = cloneAsUint8Array(chunk);
              } catch (e) {
                byteControllerError(byobBranch.controller, e);
                byteControllerError(otherBranch.controller, e);
                cancelPromise.resolve(readableStreamCancel(rs, e));
                return;
              }
              if (!byobCanceled) {
                byteControllerRespondWithNewView(
                  byobBranch.controller,
                  viewInfo(chunk),
                );
              }
              byteControllerEnqueue(otherBranch.controller, viewInfo(cloned));
            } else if (!byobCanceled) {
              byteControllerRespondWithNewView(
                byobBranch.controller,
                viewInfo(chunk),
              );
            }
            reading = false;
            if (readAgainForBranch1) pull1();
            else if (readAgainForBranch2) pull2();
          });
        },
        close: (chunk) => {
          reading = false;
          const byobCanceled = forBranch2 ? canceled2 : canceled1;
          const otherCanceled = forBranch2 ? canceled1 : canceled2;
          if (!byobCanceled) byteControllerClose(byobBranch.controller);
          if (!otherCanceled) byteControllerClose(otherBranch.controller);
          if (chunk !== undefined) {
            if (!byobCanceled) {
              byteControllerRespondWithNewView(
                byobBranch.controller,
                viewInfo(chunk),
              );
            }
            if (
              !otherCanceled &&
              otherBranch.controller.pendingPullIntos.length > 0
            ) {
              byteControllerRespond(otherBranch.controller, 0);
            }
          }
          if (!byobCanceled || !otherCanceled) cancelPromise.resolve(undefined);
        },
        error: () => {
          reading = false;
        },
      });
    };
    const pull1 = (): Promise<Any> => {
      if (reading) {
        readAgainForBranch1 = true;
        return resolvedWith();
      }
      reading = true;
      const request = byteControllerGetBYOBRequest(branch1.controller);
      if (request === null) pullWithDefaultReader();
      else pullWithBYOBReader(request.view, false);
      return resolvedWith();
    };
    const pull2 = (): Promise<Any> => {
      if (reading) {
        readAgainForBranch2 = true;
        return resolvedWith();
      }
      reading = true;
      const request = byteControllerGetBYOBRequest(branch2.controller);
      if (request === null) pullWithDefaultReader();
      else pullWithBYOBReader(request.view, true);
      return resolvedWith();
    };
    const cancel1 = (reason: Any): Promise<Any> => {
      canceled1 = true;
      reason1 = reason;
      if (canceled2) {
        cancelPromise.resolve(readableStreamCancel(rs, [reason1, reason2]));
      }
      return cancelPromise.promise;
    };
    const cancel2 = (reason: Any): Promise<Any> => {
      canceled2 = true;
      reason2 = reason;
      if (canceled1) {
        cancelPromise.resolve(readableStreamCancel(rs, [reason1, reason2]));
      }
      return cancelPromise.promise;
    };
    const start = () => undefined;
    branch1 = createReadableByteStream(start, pull1, cancel1);
    branch2 = createReadableByteStream(start, pull2, cancel2);
    forwardReaderError(reader);
    return [branch1, branch2];
  };

  const readableStreamTee = (rs: Any): [Any, Any] =>
    rs.controller.tag === 'RBC' ? byteTee(rs) : defaultTee(rs);

  // --- from an iterable ---------------------------------------------------------

  const getMethod = (o: Any, key: Any): Any => {
    const f = o[key];
    if (f === undefined || f === null) return undefined;
    if (typeof f !== 'function') throw typeError(`${String(key)} is not a function`);
    return f;
  };
  /** GetIterator(obj, async), a sync iterator made async as
   *  CreateAsyncFromSyncIterator makes one. */
  const asyncIteratorOf = (o: Any): { iterator: Any; next: Any } => {
    let method = getMethod(o, Symbol.asyncIterator);
    if (method === undefined) {
      const syncMethod = getMethod(o, Symbol.iterator);
      if (syncMethod === undefined) {
        throw typeError("Failed to execute 'from' on 'ReadableStream': The provided value is not an async iterable.");
      }
      const sync = apply(syncMethod, o, []);
      if (!isObject(sync)) throw typeError('The iterator is not an object');
      const syncNext = sync.next;
      const settle = (r: Any): Any => {
        if (!isObject(r)) throw typeError('The iterator result is not an object');
        const done = !!r.done;
        return react(resolvedWith(r.value), (value: Any) => ({ value, done }));
      };
      const iterator = {
        next() {
          try {
            return settle(apply(syncNext, sync, []));
          } catch (e) {
            return rejectedWith(e);
          }
        },
        return(value: Any) {
          try {
            const ret = sync.return;
            if (ret === undefined || ret === null) {
              return resolvedWith({ value, done: true });
            }
            return settle(apply(ret, sync, [value]));
          } catch (e) {
            return rejectedWith(e);
          }
        },
      };
      return { iterator, next: iterator.next };
    }
    const iterator = apply(method, o, []);
    if (!isObject(iterator)) throw typeError('The iterator is not an object');
    return { iterator, next: iterator.next };
  };
  const readableStreamFromIterable = (iterable: Any): Any => {
    if (!isObject(iterable)) {
      throw typeError("Failed to execute 'from' on 'ReadableStream': The provided value is not an async iterable.");
    }
    const record = asyncIteratorOf(iterable);
    let rs: Any;
    const pull = (): Promise<Any> => {
      let result: Any;
      try {
        result = apply(record.next, record.iterator, []);
      } catch (e) {
        return rejectedWith(e);
      }
      return react(resolvedWith(result), (r: Any) => {
        if (!isObject(r)) {
          throw typeError('The promise returned by the iterator.next() method must fulfill with an object');
        }
        if (r.done) defaultControllerClose(rs.controller);
        else defaultControllerEnqueue(rs.controller, r.value);
      });
    };
    const cancel = (reason: Any): Promise<Any> => {
      const iterator = record.iterator;
      let ret: Any;
      try {
        ret = getMethod(iterator, 'return');
      } catch (e) {
        return rejectedWith(e);
      }
      if (ret === undefined) return resolvedWith();
      let result: Any;
      try {
        result = apply(ret, iterator, [reason]);
      } catch (e) {
        return rejectedWith(e);
      }
      return react(resolvedWith(result), (r: Any) => {
        if (!isObject(r)) {
          throw typeError('The promise returned by the iterator.return() method must fulfill with an object');
        }
      });
    };
    rs = createReadableStream(() => undefined, pull, cancel, 0);
    return rs;
  };

  // --- async iteration --------------------------------------------------------

  const ITERATORS = new WM();
  const ReadableStreamAsyncIteratorPrototype = objectCreate(
    AsyncIteratorPrototype,
  );
  const iterResult = (value: Any, done: boolean): Any => ({ value, done });
  const iteratorState = (it: Any): Any =>
    isObject(it) ? apply(wmGet, ITERATORS, [it]) : undefined;
  // methods, for their names and lengths: `next` of none, `return` of one
  const iteratorMethods = {
    next(this: Any): Promise<Any> {
      const s = iteratorState(this);
      if (!s) return rejectedWith(illegal());
      const nextSteps = (): Promise<Any> => {
        if (s.finished) return resolvedWith(iterResult(undefined, true));
        const reader = s.reader;
        const d = deferred();
        defaultReaderRead(reader, {
          chunk: (chunk) => d.resolve(chunk),
          close: () => {
            readerRelease(reader);
            d.resolve(END);
          },
          error: (e) => {
            readerRelease(reader);
            d.reject(e);
          },
        });
        return react(
          d.promise,
          (v: Any) => {
            if (v === END) {
              s.finished = true;
              return iterResult(undefined, true);
            }
            return iterResult(v, false);
          },
          (e: Any) => {
            s.finished = true;
            throw e;
          },
        );
      };
      const ongoing = s.ongoing
        ? react(s.ongoing, nextSteps, nextSteps)
        : nextSteps();
      s.ongoing = ongoing;
      upon(ongoing, () => {
        if (s.ongoing === ongoing) s.ongoing = null;
      }, () => {
        if (s.ongoing === ongoing) s.ongoing = null;
      });
      return ongoing;
    },
    return(this: Any, value: Any): Promise<Any> {
      const s = iteratorState(this);
      if (!s) return rejectedWith(illegal());
      const returnSteps = (): Promise<Any> => {
        if (s.finished) return resolvedWith(iterResult(value, true));
        s.finished = true;
        const reader = s.reader;
        if (reader.stream === undefined) return resolvedWith();
        if (!s.preventCancel) {
          const result = readableStreamCancel(reader.stream, value);
          readerRelease(reader);
          return result;
        }
        readerRelease(reader);
        return resolvedWith();
      };
      const after = s.ongoing
        ? react(s.ongoing, returnSteps, returnSteps)
        : returnSteps();
      const done = react(after, () => iterResult(value, true));
      // a next() or a return() after this one waits for it
      s.ongoing = done;
      upon(done, () => {
        if (s.ongoing === done) s.ongoing = null;
      }, () => {
        if (s.ongoing === done) s.ongoing = null;
      });
      return done;
    },
  };
  for (const key of ['next', 'return']) {
    defineProperty(ReadableStreamAsyncIteratorPrototype, key, {
      value: (iteratorMethods as Any)[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  defineProperty(ReadableStreamAsyncIteratorPrototype, Symbol.toStringTag, {
    value: 'ReadableStream AsyncIterator',
    configurable: true,
  });
  const END = objectCreate(null);

  // --- piping -------------------------------------------------------------------

  const pipeOptions = (options: Any): Any => {
    const d = dictionary(options, 'StreamPipeOptions');
    if (!d) {
      return {
        preventAbort: false,
        preventCancel: false,
        preventClose: false,
        signal: undefined,
      };
    }
    const preventAbort = !!d.preventAbort;
    const preventCancel = !!d.preventCancel;
    const preventClose = !!d.preventClose;
    const signal = d.signal;
    if (
      signal !== undefined &&
      (!(signal instanceof AbortSignalCtor()) ||
        !apply(hasOwn, signal, ['aborted']))
    ) {
      throw typeError("Failed to read the 'signal' property from 'StreamPipeOptions': Failed to convert value to 'AbortSignal'.");
    }
    return { preventAbort, preventCancel, preventClose, signal };
  };

  const readableStreamPipeTo = (
    source: Any,
    dest: Any,
    preventClose: boolean,
    preventAbort: boolean,
    preventCancel: boolean,
    signal: Any,
  ): Promise<Any> => {
    const reader = acquireDefaultReader(source);
    const writer = acquireWriter(dest);
    source.disturbed = true;
    let shuttingDown = false;
    let currentWrite = resolvedWith();
    const result = deferred();
    let abortAlgorithm: Any;

    const finalize = (isError: boolean, error?: Any): void => {
      writerRelease(writer);
      readerRelease(reader);
      if (signal !== undefined) {
        signal.removeEventListener('abort', abortAlgorithm);
      }
      if (isError) result.reject(error);
      else result.resolve(undefined);
    };
    const waitForWritesToFinish = (): Promise<Any> => {
      const old = currentWrite;
      return react(old, () =>
        old !== currentWrite ? waitForWritesToFinish() : undefined,
      );
    };
    const shutdownWithAction = (
      action: () => Promise<Any>,
      originalIsError?: boolean,
      originalError?: Any,
    ): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      const doTheRest = (): void => {
        upon(
          action(),
          () => finalize(!!originalIsError, originalError),
          (newError: Any) => finalize(true, newError),
        );
      };
      if (dest.state === 'writable' && !closeQueuedOrInFlight(dest)) {
        upon(waitForWritesToFinish(), doTheRest);
      } else doTheRest();
    };
    const shutdown = (isError?: boolean, error?: Any): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (dest.state === 'writable' && !closeQueuedOrInFlight(dest)) {
        upon(waitForWritesToFinish(), () => finalize(!!isError, error));
      } else finalize(!!isError, error);
    };

    if (signal !== undefined) {
      abortAlgorithm = (): void => {
        const error = signal.reason;
        const actions: (() => Promise<Any>)[] = [];
        if (!preventAbort) {
          actions[actions.length] = () =>
            dest.state === 'writable'
              ? writableStreamAbort(dest, error)
              : resolvedWith();
        }
        if (!preventCancel) {
          actions[actions.length] = () =>
            source.state === 'readable'
              ? readableStreamCancel(source, error)
              : resolvedWith();
        }
        shutdownWithAction(
          () => {
            const promises: Promise<Any>[] = [];
            for (let i = 0; i < actions.length; i += 1) {
              promises[promises.length] = actions[i]();
            }
            return waitAll(promises);
          },
          true,
          error,
        );
      };
      if (signal.aborted) {
        abortAlgorithm();
        return result.promise;
      }
      signal.addEventListener('abort', abortAlgorithm);
    }

    const pipeStep = (): Promise<boolean> => {
      if (shuttingDown) return resolvedWith(true);
      return react(writer.ready.promise, () => {
        const d = deferred();
        defaultReaderRead(reader, {
          // written a microtask later: a source's enqueue() does not run
          // the sink's write algorithm inside it
          // and the write it is waited for as soon as it is read
          chunk: (chunk) => {
            const written = deferred();
            currentWrite = written.promise;
            microtask(() => {
              if (writer.stream === undefined) {
                written.resolve(undefined);
                d.resolve(true);
                return;
              }
              upon(
                writerWrite(writer, chunk),
                () => written.resolve(undefined),
                () => written.resolve(undefined),
              );
              d.resolve(false);
            });
          },
          close: () => d.resolve(true),
          error: (e) => d.reject(e),
        });
        return d.promise;
      });
    };
    const pipeLoop = (): Promise<Any> => {
      const d = deferred();
      const next = (done: boolean): void => {
        if (done) d.resolve(undefined);
        else upon(pipeStep(), next, (e: Any) => d.reject(e));
      };
      next(false);
      return d.promise;
    };

    // errors must be propagated forward
    const isOrBecomesErrored = (
      stream: Any,
      promise: Promise<Any>,
      action: (e: Any) => void,
    ): void => {
      if (stream.state === 'errored') action(stream.storedError);
      else upon(promise, undefined, action);
    };
    const isOrBecomesClosed = (
      stream: Any,
      promise: Promise<Any>,
      action: () => void,
    ): void => {
      if (stream.state === 'closed') action();
      else upon(promise, action);
    };
    isOrBecomesErrored(source, reader.closed.promise, (storedError) => {
      if (!preventAbort) {
        shutdownWithAction(
          () => writableStreamAbort(dest, storedError),
          true,
          storedError,
        );
      } else shutdown(true, storedError);
    });
    isOrBecomesErrored(dest, writer.closed.promise, (storedError) => {
      if (!preventCancel) {
        shutdownWithAction(
          () => readableStreamCancel(source, storedError),
          true,
          storedError,
        );
      } else shutdown(true, storedError);
    });
    isOrBecomesClosed(source, reader.closed.promise, () => {
      if (!preventClose) {
        shutdownWithAction(() => writerCloseWithErrorPropagation(writer));
      } else shutdown();
    });
    if (closeQueuedOrInFlight(dest) || dest.state === 'closed') {
      const destClosed = typeError('the destination writable stream closed before all data could be piped to it');
      if (!preventCancel) {
        shutdownWithAction(
          () => readableStreamCancel(source, destClosed),
          true,
          destClosed,
        );
      } else shutdown(true, destClosed);
    }
    markHandled(pipeLoop());
    return result.promise;
  };
  /** `Promise.all` over this realm's own promises, as the standard waits
   *  for all of them. */
  const waitAll = (promises: Promise<Any>[]): Promise<Any> => {
    const d = deferred();
    let left = promises.length;
    if (left === 0) d.resolve(undefined);
    for (let i = 0; i < promises.length; i += 1) {
      upon(
        promises[i],
        () => {
          left -= 1;
          if (left === 0) d.resolve(undefined);
        },
        (e: Any) => d.reject(e),
      );
    }
    return d.promise;
  };

  // --- the interface --------------------------------------------------------------

  class ReadableStream {
    constructor(underlyingSource: Any = undefined, strategy: Any = undefined) {
      if (underlyingSource === INTERNAL) {
        initReadableStream(this);
        return;
      }
      if (underlyingSource !== undefined && !isObject(underlyingSource)) {
        throw typeError("Failed to construct 'ReadableStream': The provided value is not of type 'object'.");
      }
      const st = strategyOf(strategy);
      const source = underlyingSource === undefined ? null : underlyingSource;
      const d = sourceDictionary(source);
      const rs = initReadableStream(this);
      if (d.type === 'bytes') {
        if (st.size !== undefined) {
          throw rangeError("Failed to construct 'ReadableStream': The strategy for a byte stream cannot have a size function");
        }
        const hwm = extractHighWaterMark(st, 0);
        setUpByteFromSource(rs, source, d, hwm);
      } else {
        const size = extractSizeAlgorithm(st);
        const hwm = extractHighWaterMark(st, 1);
        setUpDefaultFromSource(rs, source, d, hwm, size);
      }
    }
    static from(asyncIterable: Any): Any {
      return readableStreamFromIterable(asyncIterable).obj;
    }
    get locked(): boolean {
      return isLocked(brand(this, 'RS'));
    }
    cancel(reason: Any = undefined): Promise<Any> {
      const rs = slotOf(this);
      if (!rs || rs.tag !== 'RS') return rejectedWith(illegal());
      if (isLocked(rs)) {
        return rejectedWith(typeError("Failed to execute 'cancel' on 'ReadableStream': Cannot cancel a locked stream"));
      }
      return readableStreamCancel(rs, reason);
    }
    getReader(options: Any = undefined): Any {
      const rs = brand(this, 'RS');
      const d = dictionary(options, 'ReadableStreamGetReaderOptions');
      const raw = d ? d.mode : undefined;
      if (raw === undefined) return acquireDefaultReader(rs).obj;
      const mode = `${raw}`;
      if (mode !== 'byob') {
        throw typeError(`Failed to execute 'getReader' on 'ReadableStream': Failed to read the 'mode' property from 'ReadableStreamGetReaderOptions': The provided value '${mode}' is not a valid enum value of type ReadableStreamReaderMode.`);
      }
      return acquireBYOBReader(rs).obj;
    }
    pipeThrough(transform: Any, options: Any = undefined): Any {
      const rs = brand(this, 'RS');
      if (!isObject(transform)) {
        throw typeError("Failed to execute 'pipeThrough' on 'ReadableStream': parameter 1 is not of type 'ReadableWritablePair'.");
      }
      const readable = transform.readable;
      const rr = slotOf(readable);
      if (!rr || rr.tag !== 'RS') {
        throw typeError("Failed to execute 'pipeThrough' on 'ReadableStream': Failed to read the 'readable' property from 'ReadableWritablePair': Failed to convert value to 'ReadableStream'.");
      }
      const writable = transform.writable;
      const ws = slotOf(writable);
      if (!ws || ws.tag !== 'WS') {
        throw typeError("Failed to execute 'pipeThrough' on 'ReadableStream': Failed to read the 'writable' property from 'ReadableWritablePair': Failed to convert value to 'WritableStream'.");
      }
      const o = pipeOptions(options);
      if (isLocked(rs)) {
        throw typeError("Failed to execute 'pipeThrough' on 'ReadableStream': Cannot pipe a locked stream");
      }
      if (isWritableLocked(ws)) {
        throw typeError("Failed to execute 'pipeThrough' on 'ReadableStream': Cannot pipe to a locked stream");
      }
      const promise = readableStreamPipeTo(
        rs,
        ws,
        o.preventClose,
        o.preventAbort,
        o.preventCancel,
        o.signal,
      );
      markHandled(promise);
      return readable;
    }
    pipeTo(destination: Any, options: Any = undefined): Promise<Any> {
      const rs = slotOf(this);
      if (!rs || rs.tag !== 'RS') return rejectedWith(illegal());
      const ws = slotOf(destination);
      if (!ws || ws.tag !== 'WS') {
        return rejectedWith(typeError("Failed to execute 'pipeTo' on 'ReadableStream': parameter 1 is not of type 'WritableStream'."));
      }
      let o: Any;
      try {
        o = pipeOptions(options);
      } catch (e) {
        return rejectedWith(e);
      }
      if (isLocked(rs)) {
        return rejectedWith(typeError("Failed to execute 'pipeTo' on 'ReadableStream': Cannot pipe a locked stream"));
      }
      if (isWritableLocked(ws)) {
        return rejectedWith(typeError("Failed to execute 'pipeTo' on 'ReadableStream': Cannot pipe to a locked stream"));
      }
      return readableStreamPipeTo(
        rs,
        ws,
        o.preventClose,
        o.preventAbort,
        o.preventCancel,
        o.signal,
      );
    }
    tee(): Any[] {
      const [a, b] = readableStreamTee(brand(this, 'RS'));
      return [a.obj, b.obj];
    }
    values(options: Any = undefined): Any {
      const rs = brand(this, 'RS');
      const d = dictionary(options, 'ReadableStreamIteratorOptions');
      const preventCancel = d ? !!d.preventCancel : false;
      const reader = acquireDefaultReader(rs);
      const it = objectCreate(ReadableStreamAsyncIteratorPrototype);
      apply(wmSet, ITERATORS, [
        it,
        { reader, preventCancel, ongoing: null, finished: false },
      ]);
      return it;
    }
  }
  defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    value: ReadableStream.prototype.values,
    writable: true,
    configurable: true,
  });

  // ==========================================================================
  // Writable streams
  // ==========================================================================

  const CLOSE_SENTINEL = objectCreate(null);

  const initWritableStream = (obj: Any): Any => {
    const ws = {
      tag: 'WS',
      obj,
      state: 'writable',
      storedError: undefined as Any,
      writer: undefined as Any,
      controller: undefined as Any,
      inFlightWriteRequest: undefined as Any,
      closeRequest: undefined as Any,
      inFlightCloseRequest: undefined as Any,
      pendingAbortRequest: undefined as Any,
      writeRequests: new Queue<Deferred>(),
      backpressure: false,
    };
    own(obj, ws);
    return ws;
  };
  const isWritableLocked = (ws: Any): boolean => ws.writer !== undefined;

  const writableStreamAbort = (ws: Any, reason: Any): Promise<Any> => {
    if (ws.state === 'closed' || ws.state === 'errored') return resolvedWith();
    ws.controller.abortController.abort(reason);
    const state = ws.state;
    if (state === 'closed' || state === 'errored') return resolvedWith();
    if (ws.pendingAbortRequest !== undefined) {
      return ws.pendingAbortRequest.promise.promise;
    }
    let wasAlreadyErroring = false;
    if (state === 'erroring') {
      wasAlreadyErroring = true;
      reason = undefined;
    }
    const promise = deferred();
    ws.pendingAbortRequest = { promise, reason, wasAlreadyErroring };
    if (!wasAlreadyErroring) writableStreamStartErroring(ws, reason);
    return promise.promise;
  };
  const writableStreamClose = (ws: Any): Promise<Any> => {
    const state = ws.state;
    if (state === 'closed' || state === 'errored') {
      return rejectedWith(typeError(`The stream (in ${state} state) is not in the writable state and cannot be closed`));
    }
    const promise = deferred();
    ws.closeRequest = promise;
    const writer = ws.writer;
    if (writer !== undefined && ws.backpressure && state === 'writable') {
      writer.ready.resolve(undefined);
    }
    writableControllerClose(ws.controller);
    return promise.promise;
  };
  const writableStreamAddWriteRequest = (ws: Any): Promise<Any> => {
    const d = deferred();
    ws.writeRequests.push(d);
    return d.promise;
  };
  const writableStreamDealWithRejection = (ws: Any, error: Any): void => {
    if (ws.state === 'writable') {
      writableStreamStartErroring(ws, error);
      return;
    }
    writableStreamFinishErroring(ws);
  };
  const writableStreamStartErroring = (ws: Any, reason: Any): void => {
    const controller = ws.controller;
    ws.state = 'erroring';
    ws.storedError = reason;
    const writer = ws.writer;
    if (writer !== undefined) writerEnsureReadyPromiseRejected(writer, reason);
    if (!hasOperationMarkedInFlight(ws) && controller.started) {
      writableStreamFinishErroring(ws);
    }
  };
  const writableStreamFinishErroring = (ws: Any): void => {
    ws.state = 'errored';
    ws.controller.errorSteps();
    const storedError = ws.storedError;
    const requests = ws.writeRequests;
    ws.writeRequests = new Queue();
    while (requests.length) requests.shift().reject(storedError);
    if (ws.pendingAbortRequest === undefined) {
      writableStreamRejectCloseAndClosedPromiseIfNeeded(ws);
      return;
    }
    const abortRequest = ws.pendingAbortRequest;
    ws.pendingAbortRequest = undefined;
    if (abortRequest.wasAlreadyErroring) {
      abortRequest.promise.reject(storedError);
      writableStreamRejectCloseAndClosedPromiseIfNeeded(ws);
      return;
    }
    const promise = ws.controller.abortSteps(abortRequest.reason);
    upon(
      promise,
      () => {
        abortRequest.promise.resolve(undefined);
        writableStreamRejectCloseAndClosedPromiseIfNeeded(ws);
      },
      (reason: Any) => {
        abortRequest.promise.reject(reason);
        writableStreamRejectCloseAndClosedPromiseIfNeeded(ws);
      },
    );
  };
  const writableStreamFinishInFlightWrite = (ws: Any): void => {
    ws.inFlightWriteRequest.resolve(undefined);
    ws.inFlightWriteRequest = undefined;
  };
  const writableStreamFinishInFlightWriteWithError = (ws: Any, e: Any) => {
    ws.inFlightWriteRequest.reject(e);
    ws.inFlightWriteRequest = undefined;
    writableStreamDealWithRejection(ws, e);
  };
  const writableStreamFinishInFlightClose = (ws: Any): void => {
    ws.inFlightCloseRequest.resolve(undefined);
    ws.inFlightCloseRequest = undefined;
    if (ws.state === 'erroring') {
      ws.storedError = undefined;
      if (ws.pendingAbortRequest !== undefined) {
        ws.pendingAbortRequest.promise.resolve(undefined);
        ws.pendingAbortRequest = undefined;
      }
    }
    ws.state = 'closed';
    const writer = ws.writer;
    if (writer !== undefined) writer.closed.resolve(undefined);
  };
  const writableStreamFinishInFlightCloseWithError = (ws: Any, e: Any) => {
    ws.inFlightCloseRequest.reject(e);
    ws.inFlightCloseRequest = undefined;
    if (ws.pendingAbortRequest !== undefined) {
      ws.pendingAbortRequest.promise.reject(e);
      ws.pendingAbortRequest = undefined;
    }
    writableStreamDealWithRejection(ws, e);
  };
  const closeQueuedOrInFlight = (ws: Any): boolean =>
    ws.closeRequest !== undefined || ws.inFlightCloseRequest !== undefined;
  const hasOperationMarkedInFlight = (ws: Any): boolean =>
    ws.inFlightWriteRequest !== undefined ||
    ws.inFlightCloseRequest !== undefined;
  const writableStreamMarkCloseRequestInFlight = (ws: Any): void => {
    ws.inFlightCloseRequest = ws.closeRequest;
    ws.closeRequest = undefined;
  };
  const writableStreamMarkFirstWriteRequestInFlight = (ws: Any): void => {
    ws.inFlightWriteRequest = ws.writeRequests.shift();
  };
  const writableStreamRejectCloseAndClosedPromiseIfNeeded = (ws: Any) => {
    if (ws.closeRequest !== undefined) {
      ws.closeRequest.reject(ws.storedError);
      ws.closeRequest = undefined;
    }
    const writer = ws.writer;
    if (writer !== undefined) {
      writer.closed.reject(ws.storedError);
      markHandled(writer.closed.promise);
    }
  };
  const writableStreamUpdateBackpressure = (ws: Any, bp: boolean): void => {
    const writer = ws.writer;
    if (writer !== undefined && bp !== ws.backpressure) {
      if (bp) writer.ready = deferred();
      else writer.ready.resolve(undefined);
    }
    ws.backpressure = bp;
  };

  // --- the writer -----------------------------------------------------------------

  const setUpWriter = (obj: Any, ws: Any): Any => {
    if (isWritableLocked(ws)) {
      throw typeError("Failed to construct 'WritableStreamDefaultWriter': Cannot create writer when WritableStream is locked");
    }
    const writer: Any = {
      tag: 'WSDW',
      obj,
      stream: ws,
      ready: undefined,
      closed: undefined,
    };
    ws.writer = writer;
    const state = ws.state;
    if (state === 'writable') {
      writer.ready =
        !closeQueuedOrInFlight(ws) && ws.backpressure
          ? deferred()
          : resolvedDeferred();
      writer.closed = deferred();
    } else if (state === 'erroring') {
      writer.ready = rejectedDeferred(ws.storedError);
      writer.closed = deferred();
    } else if (state === 'closed') {
      writer.ready = resolvedDeferred();
      writer.closed = resolvedDeferred();
    } else {
      writer.ready = rejectedDeferred(ws.storedError);
      writer.closed = rejectedDeferred(ws.storedError);
    }
    own(obj, writer);
    return writer;
  };
  const acquireWriter = (ws: Any): Any =>
    slotOf(new WritableStreamDefaultWriter(ws.obj));
  const writerEnsureClosedPromiseRejected = (writer: Any, e: Any): void => {
    if (writer.closed.state === 0) writer.closed.reject(e);
    else writer.closed = rejectedDeferred(e);
    markHandled(writer.closed.promise);
  };
  const writerEnsureReadyPromiseRejected = (writer: Any, e: Any): void => {
    if (writer.ready.state === 0) writer.ready.reject(e);
    else writer.ready = rejectedDeferred(e);
    markHandled(writer.ready.promise);
  };
  const writerDesiredSize = (writer: Any): number | null => {
    const ws = writer.stream;
    const state = ws.state;
    if (state === 'errored' || state === 'erroring') return null;
    if (state === 'closed') return 0;
    return writableControllerDesiredSize(ws.controller);
  };
  const writerRelease = (writer: Any): void => {
    const ws = writer.stream;
    const released = typeError("Writer was released and can no longer be used to monitor the stream's closedness");
    writerEnsureReadyPromiseRejected(writer, released);
    writerEnsureClosedPromiseRejected(writer, released);
    ws.writer = undefined;
    writer.stream = undefined;
  };
  const writerWrite = (writer: Any, chunk: Any): Promise<Any> => {
    const ws = writer.stream;
    const controller = ws.controller;
    const chunkSize = writableControllerGetChunkSize(controller, chunk);
    if (ws !== writer.stream) {
      return rejectedWith(typeError('The writer was released while the chunk was being sized'));
    }
    const state = ws.state;
    if (state === 'errored') return rejectedWith(ws.storedError);
    if (closeQueuedOrInFlight(ws) || state === 'closed') {
      return rejectedWith(typeError('The stream is closing or closed and cannot be written to'));
    }
    if (state === 'erroring') return rejectedWith(ws.storedError);
    const promise = writableStreamAddWriteRequest(ws);
    writableControllerWrite(controller, chunk, chunkSize);
    return promise;
  };
  const writerCloseWithErrorPropagation = (writer: Any): Promise<Any> => {
    const ws = writer.stream;
    const state = ws.state;
    if (closeQueuedOrInFlight(ws) || state === 'closed') return resolvedWith();
    if (state === 'errored') return rejectedWith(ws.storedError);
    return writableStreamClose(ws);
  };

  class WritableStreamDefaultWriter {
    constructor(stream: Any) {
      const ws = slotOf(stream);
      if (!ws || ws.tag !== 'WS') {
        throw typeError("Failed to construct 'WritableStreamDefaultWriter': parameter 1 is not of type 'WritableStream'.");
      }
      setUpWriter(this, ws);
    }
    get closed(): Promise<Any> {
      const w = slotOf(this);
      if (!w || w.tag !== 'WSDW') return rejectedWith(illegal());
      return w.closed.promise;
    }
    get desiredSize(): number | null {
      const w = brand(this, 'WSDW');
      if (w.stream === undefined) {
        throw typeError('This writable stream writer has been released and cannot be used to get the desired size');
      }
      return writerDesiredSize(w);
    }
    get ready(): Promise<Any> {
      const w = slotOf(this);
      if (!w || w.tag !== 'WSDW') return rejectedWith(illegal());
      return w.ready.promise;
    }
    abort(reason: Any = undefined): Promise<Any> {
      const w = slotOf(this);
      if (!w || w.tag !== 'WSDW') return rejectedWith(illegal());
      if (w.stream === undefined) {
        return rejectedWith(typeError('This writable stream writer has been released and cannot be used to abort'));
      }
      return writableStreamAbort(w.stream, reason);
    }
    close(): Promise<Any> {
      const w = slotOf(this);
      if (!w || w.tag !== 'WSDW') return rejectedWith(illegal());
      const ws = w.stream;
      if (ws === undefined) {
        return rejectedWith(typeError('This writable stream writer has been released and cannot be used to close'));
      }
      if (closeQueuedOrInFlight(ws)) {
        return rejectedWith(typeError('Cannot close an already-closing stream'));
      }
      return writableStreamClose(ws);
    }
    releaseLock(): void {
      const w = brand(this, 'WSDW');
      if (w.stream === undefined) return;
      writerRelease(w);
    }
    write(chunk: Any = undefined): Promise<Any> {
      const w = slotOf(this);
      if (!w || w.tag !== 'WSDW') return rejectedWith(illegal());
      if (w.stream === undefined) {
        return rejectedWith(typeError('This writable stream writer has been released and cannot be used to write'));
      }
      return writerWrite(w, chunk);
    }
  }

  // --- the controller ---------------------------------------------------------------

  const writableControllerClearAlgorithms = (c: Any): void => {
    c.writeAlgorithm = undefined;
    c.closeAlgorithm = undefined;
    c.abortAlgorithm = undefined;
    c.strategySizeAlgorithm = undefined;
  };
  const writableControllerDesiredSize = (c: Any): number =>
    c.strategyHWM - c.queueTotalSize;
  const writableControllerGetBackpressure = (c: Any): boolean =>
    writableControllerDesiredSize(c) <= 0;
  const writableControllerError = (c: Any, error: Any): void => {
    writableControllerClearAlgorithms(c);
    writableStreamStartErroring(c.stream, error);
  };
  const writableControllerErrorIfNeeded = (c: Any, error: Any): void => {
    if (c.stream.state === 'writable') writableControllerError(c, error);
  };
  const writableControllerGetChunkSize = (c: Any, chunk: Any): number => {
    if (c.strategySizeAlgorithm === undefined) return 1;
    try {
      return c.strategySizeAlgorithm(chunk);
    } catch (e) {
      writableControllerErrorIfNeeded(c, e);
      return 1;
    }
  };
  const writableControllerClose = (c: Any): void => {
    enqueueValueWithSize(c, CLOSE_SENTINEL, 0);
    writableControllerAdvanceQueueIfNeeded(c);
  };
  const writableControllerWrite = (
    c: Any,
    chunk: Any,
    chunkSize: number,
  ): void => {
    try {
      enqueueValueWithSize(c, chunk, chunkSize);
    } catch (e) {
      writableControllerErrorIfNeeded(c, e);
      return;
    }
    const ws = c.stream;
    if (!closeQueuedOrInFlight(ws) && ws.state === 'writable') {
      writableStreamUpdateBackpressure(ws, writableControllerGetBackpressure(c));
    }
    writableControllerAdvanceQueueIfNeeded(c);
  };
  const writableControllerAdvanceQueueIfNeeded = (c: Any): void => {
    const ws = c.stream;
    if (!c.started) return;
    if (ws.inFlightWriteRequest !== undefined) return;
    if (ws.state === 'erroring') {
      writableStreamFinishErroring(ws);
      return;
    }
    if (c.queue.length === 0) return;
    const value = peekQueueValue(c);
    if (value === CLOSE_SENTINEL) writableControllerProcessClose(c);
    else writableControllerProcessWrite(c, value);
  };
  const writableControllerProcessClose = (c: Any): void => {
    const ws = c.stream;
    writableStreamMarkCloseRequestInFlight(ws);
    dequeueValue(c);
    const sinkClose = c.closeAlgorithm();
    writableControllerClearAlgorithms(c);
    upon(
      sinkClose,
      () => writableStreamFinishInFlightClose(ws),
      (reason: Any) => writableStreamFinishInFlightCloseWithError(ws, reason),
    );
  };
  const writableControllerProcessWrite = (c: Any, chunk: Any): void => {
    const ws = c.stream;
    writableStreamMarkFirstWriteRequestInFlight(ws);
    const sinkWrite = c.writeAlgorithm(chunk);
    upon(
      sinkWrite,
      () => {
        writableStreamFinishInFlightWrite(ws);
        const state = ws.state;
        dequeueValue(c);
        if (!closeQueuedOrInFlight(ws) && state === 'writable') {
          writableStreamUpdateBackpressure(
            ws,
            writableControllerGetBackpressure(c),
          );
        }
        writableControllerAdvanceQueueIfNeeded(c);
      },
      (reason: Any) => {
        if (ws.state === 'writable') writableControllerClearAlgorithms(c);
        writableStreamFinishInFlightWriteWithError(ws, reason);
      },
    );
  };

  const setUpWritableController = (
    ws: Any,
    obj: Any,
    start: () => Any,
    write: (chunk: Any) => Promise<Any>,
    close: () => Promise<Any>,
    abort: (r: Any) => Promise<Any>,
    hwm: number,
    size: (chunk: Any) => number,
  ): void => {
    const c: Any = {
      tag: 'WSDC',
      obj,
      stream: ws,
      queue: new Queue(),
      queueTotalSize: 0,
      abortController: new (AbortControllerCtor())(),
      started: false,
      strategySizeAlgorithm: size,
      strategyHWM: hwm,
      writeAlgorithm: write,
      closeAlgorithm: close,
      abortAlgorithm: abort,
    };
    c.abortSteps = (reason: Any) => {
      const result = c.abortAlgorithm(reason);
      writableControllerClearAlgorithms(c);
      return result;
    };
    c.errorSteps = () => resetQueue(c);
    own(obj, c);
    ws.controller = c;
    writableStreamUpdateBackpressure(ws, writableControllerGetBackpressure(c));
    const startResult = start();
    upon(
      resolvedWith(startResult),
      () => {
        c.started = true;
        writableControllerAdvanceQueueIfNeeded(c);
      },
      (r: Any) => {
        c.started = true;
        writableStreamDealWithRejection(ws, r);
      },
    );
  };

  class WritableStreamDefaultController {
    constructor() {
      throw illegalConstructor();
    }
    get signal(): Any {
      return brand(this, 'WSDC').abortController.signal;
    }
    error(e: Any = undefined): void {
      const c = brand(this, 'WSDC');
      if (c.stream.state !== 'writable') return;
      writableControllerError(c, e);
    }
  }

  const sinkDictionary = (sink: Any): Any => {
    const context = "Failed to construct 'WritableStream'";
    if (sink === null) return {};
    const abort = callbackMember(sink, 'abort', context);
    const close = callbackMember(sink, 'close', context);
    const start = callbackMember(sink, 'start', context);
    const type = sink.type;
    const write = callbackMember(sink, 'write', context);
    return { abort, close, start, type, write };
  };

  class WritableStream {
    constructor(underlyingSink: Any = undefined, strategy: Any = undefined) {
      if (underlyingSink === INTERNAL) {
        initWritableStream(this);
        return;
      }
      if (underlyingSink !== undefined && !isObject(underlyingSink)) {
        throw typeError("Failed to construct 'WritableStream': The provided value is not of type 'object'.");
      }
      const st = strategyOf(strategy);
      const sink = underlyingSink === undefined ? null : underlyingSink;
      const d = sinkDictionary(sink);
      if (d.type !== undefined) {
        throw rangeError("Failed to construct 'WritableStream': Invalid type is specified");
      }
      const ws = initWritableStream(this);
      const size = extractSizeAlgorithm(st);
      const hwm = extractHighWaterMark(st, 1);
      const obj = made(WritableStreamDefaultController);
      const start = d.start ? () => apply(d.start, sink, [obj]) : () => undefined;
      const write = d.write
        ? (chunk: Any) => promiseCall(d.write, sink, [chunk, obj])
        : () => resolvedWith();
      const close = d.close
        ? () => promiseCall(d.close, sink, [])
        : () => resolvedWith();
      const abort = d.abort
        ? (reason: Any) => promiseCall(d.abort, sink, [reason])
        : () => resolvedWith();
      setUpWritableController(ws, obj, start, write, close, abort, hwm, size);
    }
    get locked(): boolean {
      return isWritableLocked(brand(this, 'WS'));
    }
    abort(reason: Any = undefined): Promise<Any> {
      const ws = slotOf(this);
      if (!ws || ws.tag !== 'WS') return rejectedWith(illegal());
      if (isWritableLocked(ws)) {
        return rejectedWith(typeError("Failed to execute 'abort' on 'WritableStream': Cannot abort a locked stream"));
      }
      return writableStreamAbort(ws, reason);
    }
    close(): Promise<Any> {
      const ws = slotOf(this);
      if (!ws || ws.tag !== 'WS') return rejectedWith(illegal());
      if (isWritableLocked(ws)) {
        return rejectedWith(typeError("Failed to execute 'close' on 'WritableStream': Cannot close a locked stream"));
      }
      if (closeQueuedOrInFlight(ws)) {
        return rejectedWith(typeError("Failed to execute 'close' on 'WritableStream': Cannot close an already-closing stream"));
      }
      return writableStreamClose(ws);
    }
    getWriter(): Any {
      return acquireWriter(brand(this, 'WS')).obj;
    }
  }

  const createWritableStream = (
    start: () => Any,
    write: (chunk: Any) => Promise<Any>,
    close: () => Promise<Any>,
    abort: (r: Any) => Promise<Any>,
    hwm = 1,
    size: (chunk: Any) => number = () => 1,
    into?: Any,
  ): Any => {
    const obj = into ?? new WritableStream(INTERNAL);
    const ws = slotOf(obj);
    setUpWritableController(
      ws,
      made(WritableStreamDefaultController),
      start,
      write,
      close,
      abort,
      hwm,
      size,
    );
    return ws;
  };

  // ==========================================================================
  // Transform streams
  // ==========================================================================

  const transformStreamError = (ts: Any, e: Any): void => {
    defaultControllerError(ts.readable.controller, e);
    transformStreamErrorWritableAndUnblockWrite(ts, e);
  };
  const transformStreamErrorWritableAndUnblockWrite = (ts: Any, e: Any) => {
    transformControllerClearAlgorithms(ts.controller);
    writableControllerErrorIfNeeded(ts.writable.controller, e);
    transformStreamUnblockWrite(ts);
  };
  const transformStreamUnblockWrite = (ts: Any): void => {
    if (ts.backpressure) transformStreamSetBackpressure(ts, false);
  };
  const transformStreamSetBackpressure = (ts: Any, bp: boolean): void => {
    if (ts.backpressureChangePromise !== undefined) {
      ts.backpressureChangePromise.resolve(undefined);
    }
    ts.backpressureChangePromise = deferred();
    ts.backpressure = bp;
  };
  const transformControllerClearAlgorithms = (c: Any): void => {
    c.transformAlgorithm = undefined;
    c.flushAlgorithm = undefined;
    c.cancelAlgorithm = undefined;
  };
  const transformControllerEnqueue = (c: Any, chunk: Any): void => {
    const ts = c.stream;
    const rc = ts.readable.controller;
    if (!defaultControllerCanCloseOrEnqueue(rc)) {
      throw typeError('Readable side is not in a state that permits enqueue');
    }
    try {
      defaultControllerEnqueue(rc, chunk);
    } catch (e) {
      transformStreamErrorWritableAndUnblockWrite(ts, e);
      throw ts.readable.storedError;
    }
    const backpressure = defaultControllerHasBackpressure(rc);
    if (backpressure !== ts.backpressure) {
      transformStreamSetBackpressure(ts, true);
    }
  };
  const transformControllerError = (c: Any, e: Any): void => {
    transformStreamError(c.stream, e);
  };
  const transformControllerPerformTransform = (
    c: Any,
    chunk: Any,
  ): Promise<Any> =>
    react(c.transformAlgorithm(chunk), undefined, (r: Any) => {
      transformStreamError(c.stream, r);
      throw r;
    });
  const transformControllerTerminate = (c: Any): void => {
    const ts = c.stream;
    defaultControllerClose(ts.readable.controller);
    transformStreamErrorWritableAndUnblockWrite(
      ts,
      typeError('TransformStream terminated'),
    );
  };

  const transformSinkWrite = (ts: Any, chunk: Any): Promise<Any> => {
    const c = ts.controller;
    if (ts.backpressure) {
      return react(ts.backpressureChangePromise.promise, () => {
        const ws = ts.writable;
        if (ws.state === 'erroring') throw ws.storedError;
        return transformControllerPerformTransform(c, chunk);
      });
    }
    return transformControllerPerformTransform(c, chunk);
  };
  const transformSinkAbort = (ts: Any, reason: Any): Promise<Any> => {
    const c = ts.controller;
    if (c.finishPromise !== undefined) return c.finishPromise.promise;
    const readable = ts.readable;
    c.finishPromise = deferred();
    const cancelPromise = c.cancelAlgorithm(reason);
    transformControllerClearAlgorithms(c);
    upon(
      cancelPromise,
      () => {
        if (readable.state === 'errored') {
          c.finishPromise.reject(readable.storedError);
        } else {
          defaultControllerError(readable.controller, reason);
          c.finishPromise.resolve(undefined);
        }
      },
      (r: Any) => {
        defaultControllerError(readable.controller, r);
        c.finishPromise.reject(r);
      },
    );
    return c.finishPromise.promise;
  };
  const transformSinkClose = (ts: Any): Promise<Any> => {
    const c = ts.controller;
    if (c.finishPromise !== undefined) return c.finishPromise.promise;
    const readable = ts.readable;
    c.finishPromise = deferred();
    const flushPromise = c.flushAlgorithm();
    transformControllerClearAlgorithms(c);
    upon(
      flushPromise,
      () => {
        if (readable.state === 'errored') {
          c.finishPromise.reject(readable.storedError);
        } else {
          defaultControllerClose(readable.controller);
          c.finishPromise.resolve(undefined);
        }
      },
      (r: Any) => {
        defaultControllerError(readable.controller, r);
        c.finishPromise.reject(r);
      },
    );
    return c.finishPromise.promise;
  };
  const transformSourcePull = (ts: Any): Promise<Any> => {
    transformStreamSetBackpressure(ts, false);
    return ts.backpressureChangePromise.promise;
  };
  const transformSourceCancel = (ts: Any, reason: Any): Promise<Any> => {
    const c = ts.controller;
    if (c.finishPromise !== undefined) return c.finishPromise.promise;
    const writable = ts.writable;
    c.finishPromise = deferred();
    const cancelPromise = c.cancelAlgorithm(reason);
    transformControllerClearAlgorithms(c);
    upon(
      cancelPromise,
      () => {
        if (writable.state === 'errored') {
          c.finishPromise.reject(writable.storedError);
        } else {
          writableControllerErrorIfNeeded(writable.controller, reason);
          transformStreamUnblockWrite(ts);
          c.finishPromise.resolve(undefined);
        }
      },
      (r: Any) => {
        writableControllerErrorIfNeeded(writable.controller, r);
        transformStreamUnblockWrite(ts);
        c.finishPromise.reject(r);
      },
    );
    return c.finishPromise.promise;
  };

  class TransformStreamDefaultController {
    constructor() {
      throw illegalConstructor();
    }
    get desiredSize(): number | null {
      const c = brand(this, 'TSDC');
      return defaultControllerDesiredSize(c.stream.readable.controller);
    }
    enqueue(chunk: Any = undefined): void {
      transformControllerEnqueue(brand(this, 'TSDC'), chunk);
    }
    error(reason: Any = undefined): void {
      transformControllerError(brand(this, 'TSDC'), reason);
    }
    terminate(): void {
      transformControllerTerminate(brand(this, 'TSDC'));
    }
  }

  class TransformStream {
    constructor(
      transformer: Any = undefined,
      writableStrategy: Any = undefined,
      readableStrategy: Any = undefined,
    ) {
      if (transformer !== undefined && !isObject(transformer)) {
        throw typeError("Failed to construct 'TransformStream': The provided value is not of type 'object'.");
      }
      const ws = strategyOf(writableStrategy);
      const rst = strategyOf(readableStrategy);
      const t = transformer === undefined ? null : transformer;
      const context = "Failed to construct 'TransformStream'";
      const cancel = callbackMember(t, 'cancel', context);
      const flush = callbackMember(t, 'flush', context);
      const readableType = t ? t.readableType : undefined;
      const start = callbackMember(t, 'start', context);
      const transform = callbackMember(t, 'transform', context);
      const writableType = t ? t.writableType : undefined;
      if (readableType !== undefined) {
        throw rangeError(`${context}: Invalid readableType specified`);
      }
      if (writableType !== undefined) {
        throw rangeError(`${context}: Invalid writableType specified`);
      }
      const readableHWM = extractHighWaterMark(rst, 0);
      const readableSize = extractSizeAlgorithm(rst);
      const writableHWM = extractHighWaterMark(ws, 1);
      const writableSize = extractSizeAlgorithm(ws);
      const startPromise = deferred();
      const ts: Any = {
        tag: 'TS',
        obj: this,
        readable: undefined,
        writable: undefined,
        backpressure: undefined,
        backpressureChangePromise: undefined,
        controller: undefined,
      };
      own(this, ts);
      const startAlgorithm = () => startPromise.promise;
      ts.writable = createWritableStream(
        startAlgorithm,
        (chunk) => transformSinkWrite(ts, chunk),
        () => transformSinkClose(ts),
        (reason) => transformSinkAbort(ts, reason),
        writableHWM,
        writableSize,
      );
      ts.readable = createReadableStream(
        startAlgorithm,
        () => transformSourcePull(ts),
        (reason) => transformSourceCancel(ts, reason),
        readableHWM,
        readableSize,
      );
      transformStreamSetBackpressure(ts, true);
      const cObj = made(TransformStreamDefaultController);
      const c: Any = {
        tag: 'TSDC',
        obj: cObj,
        stream: ts,
        finishPromise: undefined,
        transformAlgorithm: (chunk: Any) => {
          try {
            transformControllerEnqueue(c, chunk);
            return resolvedWith();
          } catch (e) {
            return rejectedWith(e);
          }
        },
        flushAlgorithm: () => resolvedWith(),
        cancelAlgorithm: () => resolvedWith(),
      };
      if (transform) {
        c.transformAlgorithm = (chunk: Any) =>
          promiseCall(transform, t, [chunk, cObj]);
      }
      if (flush) c.flushAlgorithm = () => promiseCall(flush, t, [cObj]);
      if (cancel) {
        c.cancelAlgorithm = (reason: Any) => promiseCall(cancel, t, [reason]);
      }
      own(cObj, c);
      ts.controller = c;
      if (start) startPromise.resolve(apply(start, t, [cObj]));
      else startPromise.resolve(undefined);
    }
    get readable(): Any {
      return brand(this, 'TS').readable.obj;
    }
    get writable(): Any {
      return brand(this, 'TS').writable.obj;
    }
  }

  // ==========================================================================
  // Queuing strategies
  // ==========================================================================

  const strategyInit = (init: Any, name: string): number => {
    const d = dictionary(init, 'QueuingStrategyInit');
    const raw = d ? d.highWaterMark : undefined;
    if (raw === undefined) {
      throw typeError(`Failed to construct '${name}': Failed to read the 'highWaterMark' property from 'QueuingStrategyInit': Required member is undefined.`);
    }
    return +raw;
  };
  // methods, so neither is a constructor nor has a prototype
  const byteLengthSize = {
    size(chunk: Any): Any {
      return chunk.byteLength;
    },
  }.size;
  const countSize = {
    size(): number {
      return 1;
    },
  }.size;
  class ByteLengthQueuingStrategy {
    constructor(init: Any) {
      own(this, {
        tag: 'BLQS',
        hwm: strategyInit(init, 'ByteLengthQueuingStrategy'),
      });
    }
    get highWaterMark(): number {
      return brand(this, 'BLQS').hwm;
    }
    get size(): Any {
      brand(this, 'BLQS');
      return byteLengthSize;
    }
  }
  class CountQueuingStrategy {
    constructor(init: Any) {
      own(this, { tag: 'CQS', hwm: strategyInit(init, 'CountQueuingStrategy') });
    }
    get highWaterMark(): number {
      return brand(this, 'CQS').hwm;
    }
    get size(): Any {
      brand(this, 'CQS');
      return countSize;
    }
  }

  // --- Web IDL's shape ------------------------------------------------------------

  /** Members enumerable, as an interface's are (Web IDL 3.7.6, 3.7.7). */
  const idl = (Interface: Any): void => {
    for (const on of [Interface.prototype, Interface]) {
      for (const key of getOwnPropertyNames(on)) {
        if (key === 'constructor' || key === 'prototype') continue;
        if (key === 'length' || key === 'name') continue;
        const d = getOwnPropertyDescriptor(on, key)!;
        if (d.enumerable) continue;
        if (!d.get && typeof d.value !== 'function') continue;
        defineProperty(on, key, { ...d, enumerable: true });
      }
    }
  };
  const classes: Record<string, Any> = {
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamBYOBReader,
    ReadableStreamDefaultController,
    ReadableByteStreamController,
    ReadableStreamBYOBRequest,
    WritableStream,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController,
    TransformStream,
    TransformStreamDefaultController,
    ByteLengthQueuingStrategy,
    CountQueuingStrategy,
  };
  for (const name of getOwnPropertyNames(classes)) {
    const C = classes[name];
    idl(C);
    defineProperty(C.prototype, Symbol.toStringTag, {
      value: name,
      configurable: true,
    });
  }

  const readableOf = (x: Any): Any => {
    const rs = slotOf(x);
    if (!rs || rs.tag !== 'RS') throw illegal();
    return rs;
  };
  const writableOf = (x: Any): Any => {
    const ws = slotOf(x);
    if (!ws || ws.tag !== 'WS') throw illegal();
    return ws;
  };

  const internals: StreamsInternals = {
    INTERNAL,
    isReadableStream: (x) => slotOf(x)?.tag === 'RS',
    isWritableStream: (x) => slotOf(x)?.tag === 'WS',
    readable: (start, pull, cancel, hwm, size, into) =>
      createReadableStream(start, pull, cancel, hwm, size, into).obj,
    readableBytes: (start, pull, cancel, hwm, into) =>
      createReadableByteStream(start, pull, cancel, hwm, into).obj,
    writable: (start, write, close, abort, hwm, size, into) =>
      createWritableStream(start, write, close, abort, hwm, size, into).obj,
    controllerOf: (x) => readableOf(x).controller.obj,
    readableState: (x) => readableOf(x).state,
    writableState: (x) => writableOf(x).state,
    storedError: (x) => slotOf(x).storedError,
    errorWritable: (x, e) =>
      writableControllerErrorIfNeeded(writableOf(x).controller, e),
    writableSignal: (x) => writableOf(x).controller.abortController.signal,
    errorReadable: (x, e) => {
      const c = readableOf(x).controller;
      if (c.tag === 'RBC') byteControllerError(c, e);
      else defaultControllerError(c, e);
    },
    closeQueuedOrInFlight: (x) => closeQueuedOrInFlight(writableOf(x)),
    writableDesiredSize: (x) => {
      const ws = writableOf(x);
      if (ws.state === 'errored' || ws.state === 'erroring') return null;
      if (ws.state === 'closed') return 0;
      return writableControllerDesiredSize(ws.controller);
    },
    readRequests: (x) => {
      const rs = readableOf(x);
      return rs.reader ? rs.reader.requests.length : 0;
    },
    idl,
  };
  return { classes, internals };
}
