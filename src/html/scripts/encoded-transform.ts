// WebRTC Encoded Transform, as a page's scripts and its workers see it:
// `RTCRtpScriptTransform` in a window, and in a dedicated worker the
// `rtctransform` event, its `RTCRtpScriptTransformer` and the frames it
// reads and writes, `RTCEncodedVideoFrame` and `RTCEncodedAudioFrame`,
// which a window has too, since a frame can be posted to one.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing.
//
// A transform is a number of its window's realm. Made, it is posted to its
// worker as a message of its own (`post`), which the worker's realm hears as
// `rtctransform`; put on a sender or a receiver, the host tells the worker so
// (`peers.ts`: `tf`, `attach`), and each encoded frame of that side then
// crosses the worker's thread to it (`__rtcTf`, `frame`), to be read from the
// transformer's `readable`. A frame written to its `writable` goes back
// (`rtcTfAsk`, `write`) and on to be packetized or decoded.
//
// What a transformer passes on is what the specification's writeEncodedData
// has it pass: a frame its own `readable` gave, in the order it gave them,
// each once. A clone, a copy and a frame of another's are dropped there, as
// are a frame written twice and one older than the last written.

/** What `installDom` hands this. */
export interface EncodedTransformDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  DOMException: unknown;
  EventTarget: unknown;
  Event: unknown;
  setHandler(target: unknown, type: string, value: unknown): void;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  bytesOfBase64(text: string): Uint8Array;
  base64OfBytes(bytes: Uint8Array): string;
  /** The realm's streams, read as each transformer is made. */
  streams(): { ReadableStream: unknown; WritableStream: unknown };
  /** The realm's `performance.now()`. */
  now(): number;
  /** The thread a `Worker` is, or null for what is no worker. */
  workerOf(worker: unknown): number | null;
  /** Posts a transform's options to its worker, as a message of its own:
   *  throws as `postMessage` throws. */
  post(worker: unknown, n: number, options: unknown, transfer: unknown): void;
  /** What a worker's global is, which `rtctransform` is fired at. */
  global(): unknown;
}

/** What `installDom` and `webrtc.ts` reach transforms and frames
 *  through. */
export interface EncodedTransformInternals {
  interfaces: Record<string, unknown>;
  /** Whether a value is an `RTCRtpScriptTransform`. */
  isTransform(value: unknown): boolean;
  /** Puts a transform on a side: throws where it was ever on another. `owner` is the sender or the receiver, `tx` the host's
   *  number for its transceiver. */
  attach(
    transform: unknown,
    owner: unknown,
    tx: number,
    side: 'sender' | 'receiver',
  ): void;
  /** Whether a value is an encoded frame of this realm's. */
  isFrame(value: unknown): boolean;
  /** A frame's parts, for a clone: throws `DataCloneError` for one whose
   *  data was transferred. */
  partsOf(frame: unknown): {
    kind: string;
    type: string;
    metadata: Record<string, unknown>;
    data: unknown;
  };
  /** A frame made of its parts, as a clone of one makes it. */
  make(
    kind: string,
    type: string,
    metadata: Record<string, unknown>,
    data: unknown,
  ): unknown;
  /** A transform posted to this realm, a worker's (`post`): its
   *  transformer made, and told as `rtctransform`. */
  arrived(n: number, options: unknown): void;
}

export function installEncodedTransform(
  deps: EncodedTransformDeps,
): EncodedTransformInternals {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const call: Any = D.call;
  const DOMException: Any = D.DOMException;
  const EventTarget: Any = D.EventTarget;
  const Event: Any = D.Event;
  const ObjectProto = Object.prototype;
  const toTag = (v: Any): string => ObjectProto.toString.call(v).slice(8, -1);

  const slots = new WeakMap<object, Any>();
  const slotOf = (self: Any, what: string): Any => {
    const s = slots.get(self);
    if (!s || s.what !== what) throw new TypeError('Illegal invocation');
    return s;
  };

  // --- frames --------------------------------------------------------------

  const BASE_FIELDS = [
    'synchronizationSource',
    'payloadType',
    'contributingSources',
    'rtpTimestamp',
    'receiveTime',
    'captureTime',
    'senderCaptureTimeOffset',
    'mimeType',
  ];
  const FIELDS: Record<string, string[]> = {
    video: [
      ...BASE_FIELDS,
      'frameId',
      'dependencies',
      'width',
      'height',
      'spatialIndex',
      'temporalIndex',
      'timestamp',
    ],
    audio: [...BASE_FIELDS, 'sequenceNumber', 'audioLevel'],
  };

  /** A metadata value as the dictionary holds it: a copy, arrays of
   *  numbers as arrays. */
  const copyValue = (v: Any): Any =>
    Array.isArray(v) ? v.map((x) => copyValue(x)) : v;
  const copyMetadata = (m: Any, kind: string): Record<string, Any> => {
    const out: Record<string, Any> = {};
    for (const key of Object.keys(m ?? {})) {
      if (FIELDS[kind].includes(key) && m[key] !== undefined) {
        out[key] = copyValue(m[key]);
      }
    }
    return out;
  };

  const isBuffer = (v: Any): boolean => {
    const tag = toTag(v);
    return tag === 'ArrayBuffer' || tag === 'SharedArrayBuffer';
  };
  /** Whether a buffer was transferred: what `detached` says, or where a
   *  runtime has none, whether it can still be read. */
  const detached = (b: Any): boolean => {
    if (toTag(b) !== 'ArrayBuffer') return false;
    if (typeof b.detached === 'boolean') return b.detached;
    try {
      b.slice(0, 0);
      return false;
    } catch {
      return true;
    }
  };
  const copyBuffer = (b: Any): ArrayBuffer => {
    const out = new ArrayBuffer(b.byteLength);
    new Uint8Array(out).set(new Uint8Array(b));
    return out;
  };

  const make = (
    kind: string,
    type: string,
    metadata: Record<string, Any>,
    data: Any,
    owner: Any = null,
    counter = 0,
  ): Any => {
    const Kind: Any =
      kind === 'audio' ? RTCEncodedAudioFrame : RTCEncodedVideoFrame;
    const frame = Object.create(Kind.prototype);
    slots.set(frame, {
      what: 'frame',
      kind,
      type,
      metadata: copyMetadata(metadata, kind),
      data,
      owner,
      counter,
    });
    return frame;
  };

  /** A frame's slot, of the kind its interface is. */
  const frameSlot = (self: Any, kind: string): Any => {
    const s = slotOf(self, 'frame');
    if (s.kind !== kind) throw new TypeError('Illegal invocation');
    return s;
  };

  const copied = (kind: string, original: Any, options: Any): Any => {
    const name =
      kind === 'audio' ? 'RTCEncodedAudioFrame' : 'RTCEncodedVideoFrame';
    const s = slots.get(original);
    if (!s || s.what !== 'frame' || s.kind !== kind) {
      throw new TypeError(
        `Failed to construct '${name}': parameter 1 is not of type '${name}'.`,
      );
    }
    if (detached(s.data)) {
      throw new DOMException(
        `Failed to construct '${name}': the frame's data was transferred.`,
        'DataCloneError',
      );
    }
    if (
      options !== undefined &&
      options !== null &&
      typeof options !== 'object'
    ) {
      throw new TypeError(
        `Failed to construct '${name}': parameter 2 is not an object.`,
      );
    }
    const metadata = copyMetadata(s.metadata, kind);
    const given = options?.metadata;
    if (given !== undefined && given !== null) {
      if (typeof given !== 'object') {
        throw new TypeError(
          `Failed to construct '${name}': metadata is not an object.`,
        );
      }
      for (const key of Object.keys(given)) {
        if (FIELDS[kind].includes(key) && given[key] !== undefined) {
          metadata[key] = copyValue(given[key]);
        }
      }
    }
    return make(kind, s.type, metadata, copyBuffer(s.data));
  };

  const dataOf = (s: Any): Any => s.data;
  const setData = (s: Any, value: Any, name: string): void => {
    if (!isBuffer(value) || ArrayBuffer.isView(value)) {
      throw new TypeError(
        `Failed to set the 'data' property on '${name}': The provided value is not of type 'ArrayBuffer'.`,
      );
    }
    if (value.resizable === true || value.growable === true) {
      throw new TypeError(
        `Failed to set the 'data' property on '${name}': The provided ArrayBuffer value must not be resizable.`,
      );
    }
    s.data = value;
  };
  /** What `getMetadata()` answers: a copy, with the frame's times from
   *  this realm's time origin. */
  const metadataOf = (s: Any): Any => copyMetadata(s.metadata, s.kind);

  class RTCEncodedVideoFrame {
    constructor(originalFrame: Any, options: Any = {}) {
      if (arguments.length < 1) {
        throw new TypeError(
          "Failed to construct 'RTCEncodedVideoFrame': 1 argument required, but only 0 present.",
        );
      }
      return copied('video', originalFrame, options);
    }
    get type(): string {
      return frameSlot(this, 'video').type;
    }
    get timestamp(): number {
      return Number(frameSlot(this, 'video').metadata.rtpTimestamp ?? 0);
    }
    get data(): Any {
      return dataOf(frameSlot(this, 'video'));
    }
    set data(value: Any) {
      setData(frameSlot(this, 'video'), value, 'RTCEncodedVideoFrame');
    }
    getMetadata(): Any {
      return metadataOf(frameSlot(this, 'video'));
    }
  }
  class RTCEncodedAudioFrame {
    constructor(originalFrame: Any, options: Any = {}) {
      if (arguments.length < 1) {
        throw new TypeError(
          "Failed to construct 'RTCEncodedAudioFrame': 1 argument required, but only 0 present.",
        );
      }
      return copied('audio', originalFrame, options);
    }
    get timestamp(): number {
      return Number(frameSlot(this, 'audio').metadata.rtpTimestamp ?? 0);
    }
    get data(): Any {
      return dataOf(frameSlot(this, 'audio'));
    }
    set data(value: Any) {
      setData(frameSlot(this, 'audio'), value, 'RTCEncodedAudioFrame');
    }
    getMetadata(): Any {
      return metadataOf(frameSlot(this, 'audio'));
    }
  }
  /** An interface's members as Web IDL has them: enumerable, and its
   *  name its `toStringTag`. */
  const webIdl = (Kind: Any): void => {
    for (const key of Object.getOwnPropertyNames(Kind.prototype)) {
      if (key === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(Kind.prototype, key)!;
      Object.defineProperty(Kind.prototype, key, { ...d, enumerable: true });
    }
    Object.defineProperty(Kind.prototype, Symbol.toStringTag, {
      value: Kind.name,
      configurable: true,
    });
  };
  webIdl(RTCEncodedVideoFrame);
  webIdl(RTCEncodedAudioFrame);

  // --- the worker's side -----------------------------------------------------

  /** Each transformer of this realm, a worker's, by its window's number for
   *  it. */
  const transformers = new Map<number, Any>();
  /** How many frames a transformer that reads none is queued. */
  const QUEUED = 64;

  const rejected = (name: string, message: string): Promise<never> =>
    Promise.reject(new DOMException(message, name));

  /** Set while this realm makes a transformer or its event, which a page
   *  cannot. */
  let making = false;
  class RTCRtpScriptTransformer extends EventTarget {
    constructor() {
      super();
      if (!making) throw new TypeError('Illegal constructor');
    }
    get readable(): Any {
      return slotOf(this, 'transformer').readable;
    }
    get writable(): Any {
      return slotOf(this, 'transformer').writable;
    }
    get options(): Any {
      return slotOf(this, 'transformer').options;
    }
    generateKeyFrame(rid?: Any): Promise<Any> {
      let s: Any;
      try {
        s = slotOf(this, 'transformer');
      } catch (e) {
        return Promise.reject(e);
      }
      // a sender's alone, of video (WebRTC Encoded Transform, 4.3)
      if (s.side !== 'sender' || s.kind !== 'video') {
        return rejected(
          'InvalidStateError',
          'generateKeyFrame() is a video sender transform’s.',
        );
      }
      if (rid !== undefined) {
        const text = String(rid);
        // RFC 8851's rid-syntax, which RFC 8852's narrows
        if (!/^[A-Za-z0-9]{1,255}$/.test(text)) {
          return rejected('NotAllowedError', `The rid '${text}' is not valid.`);
        }
        return rejected(
          'NotFoundError',
          `The sender has no encoding with the rid '${text}'.`,
        );
      }
      return new Promise((resolve) => {
        s.keyWaiters.push(resolve);
        if (s.attached) call('rtcTfAsk', s.n, 'key', 'null');
      });
    }
    sendKeyFrameRequest(): Promise<void> {
      let s: Any;
      try {
        s = slotOf(this, 'transformer');
      } catch (e) {
        return Promise.reject(e);
      }
      if (s.side !== 'receiver' || s.kind !== 'video') {
        return rejected(
          'InvalidStateError',
          'sendKeyFrameRequest() is a video receiver transform’s.',
        );
      }
      // taken off its receiver, it asks nothing (4.3.2)
      if (!s.attached) return Promise.resolve();
      return new Promise((resolve) => {
        const req = ++s.requests;
        s.requestWaiters.set(req, resolve);
        call('rtcTfAsk', s.n, 'pli', String(req));
      });
    }
  }
  Object.defineProperty(
    RTCRtpScriptTransformer.prototype,
    'onkeyframerequest',
    {
      get(this: Any): Any {
        slotOf(this, 'transformer');
        return this._handlers?.keyframerequest ?? null;
      },
      set(this: Any, fn: Any) {
        slotOf(this, 'transformer');
        D.setHandler(
          this,
          'keyframerequest',
          typeof fn === 'function' ? fn : null,
        );
      },
      enumerable: true,
      configurable: true,
    },
  );

  webIdl(RTCRtpScriptTransformer);

  class RTCTransformEvent extends Event {
    constructor(type: Any, init?: Any) {
      super(type, init);
      if (!making) throw new TypeError('Illegal constructor');
    }
    get transformer(): Any {
      return slotOf(this, 'transformEvent').transformer;
    }
  }

  webIdl(RTCTransformEvent);

  /** writeEncodedData (WebRTC Encoded Transform, 3.2): a frame this
   *  transformer's readable gave, newer than the last written, goes on. */
  const writeEncoded = (s: Any, chunk: Any): void => {
    const f = slots.get(chunk);
    if (!f || f.what !== 'frame') {
      throw new TypeError(
        'A transformer writes RTCEncodedVideoFrame and RTCEncodedAudioFrame objects alone.',
      );
    }
    if (f.owner !== s || f.counter <= s.lastWritten) return;
    s.lastWritten = f.counter;
    const data = f.data;
    if (detached(data)) return;
    const bytes = new Uint8Array(data).slice();
    // the frame's data is the stack's from now on (3.2, step 9): the page's
    // buffer is left detached
    if (toTag(data) === 'ArrayBuffer' && typeof data.transfer === 'function') {
      try {
        data.transfer();
      } catch {}
    }
    if (!s.attached) return;
    call(
      'rtcTfAsk',
      s.n,
      'write',
      JSON.stringify({
        k: f.kind,
        y: f.type,
        d: D.base64OfBytes(bytes),
        m: f.metadata,
      }),
    );
  };

  /** A transform posted to this realm, a worker's: its transformer, told
   *  as `rtctransform` (3.3, "Operations"). */
  const arrived = (n: number, options: Any): void => {
    const { ReadableStream, WritableStream } = D.streams();
    making = true;
    let transformer: Any;
    let made: Any;
    try {
      transformer = new (RTCRtpScriptTransformer as Any)();
      made = new (RTCTransformEvent as Any)('rtctransform');
    } finally {
      making = false;
    }
    const s: Any = {
      what: 'transformer',
      n,
      options,
      side: null,
      kind: null,
      attached: false,
      counter: 0,
      lastWritten: 0,
      controller: null,
      keyWaiters: [] as Any[],
      requestWaiters: new Map<number, Any>(),
      requests: 0,
    };
    s.readable = new ReadableStream(
      {
        start(controller: Any) {
          s.controller = controller;
        },
      },
      // what arrives is queued whether or not it is read, up to a point
      { highWaterMark: 0 },
    );
    s.writable = new WritableStream({
      write(chunk: Any) {
        writeEncoded(s, chunk);
      },
    });
    slots.set(transformer, s);
    transformers.set(n, s);
    slots.set(made, { what: 'transformEvent', transformer });
    D.fire(D.global(), made);
  };

  /** What became of a transform of this realm's, a worker's. */
  D.entry('__rtcTf', () => {
    const [n, e, v] = D.input() as [number, string, Any];
    const s = transformers.get(Number(n));
    if (!s) return false;
    if (e === 'attach') {
      s.attached = true;
      s.side = v?.side === 'receiver' ? 'receiver' : 'sender';
      s.kind = v?.kind === 'audio' ? 'audio' : 'video';
      // a key frame asked for before the transform was on its sender
      if (s.keyWaiters.length) call('rtcTfAsk', s.n, 'key', 'null');
    } else if (e === 'detach') {
      s.attached = false;
    } else if (e === 'frame') {
      const bytes = D.bytesOfBase64(String(v?.d ?? ''));
      const metadata = { ...(v?.m ?? {}) };
      // a time is the host's clock's, and a frame's is this realm's: it is
      // carried as how long before the host sent the frame (`t`) it was,
      // and is that long before now here. A worker's clock starts on
      // another thread's, whose origin is not the page process's, so no
      // origin both share converts one into the other
      const sent = Number(v?.t);
      const here = D.now();
      for (const key of ['receiveTime', 'captureTime']) {
        if (typeof metadata[key] === 'number') {
          metadata[key] = Number.isFinite(sent)
            ? here - (sent - metadata[key])
            : here;
        }
      }
      const kind = v?.k === 'audio' ? 'audio' : 'video';
      const type = kind === 'video' && v?.y === 'delta' ? 'delta' : 'key';
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      const frame = make(kind, type, metadata, buffer, s, ++s.counter);
      // generateKeyFrame() settles with the key frame's timestamp, before
      // the frame is enqueued (4.3.1)
      if (kind === 'video' && type === 'key' && s.keyWaiters.length) {
        const ts = Number(metadata.rtpTimestamp ?? 0);
        for (const resolve of s.keyWaiters.splice(0)) resolve(ts);
      }
      try {
        // a transformer that reads none of them is dropped what arrives
        // past a second's worth or so
        const size = s.controller.desiredSize;
        if (size === null || size < -QUEUED) return true;
        s.controller.enqueue(frame);
      } catch {}
    } else if (e === 'settled') {
      const req = Number(v);
      const resolve = s.requestWaiters.get(req);
      s.requestWaiters.delete(req);
      resolve?.();
    }
    return true;
  });

  // --- the window's side -----------------------------------------------------

  let transforms = 0;
  class RTCRtpScriptTransform {
    constructor(worker: Any, ...rest: Any[]) {
      const [options, transfer] = rest;
      if (arguments.length < 1) {
        throw new TypeError(
          "Failed to construct 'RTCRtpScriptTransform': 1 argument required, but only 0 present.",
        );
      }
      let target = worker;
      if (D.workerOf(target) === null && target && typeof target === 'object') {
        target = target.worker;
      }
      const thread = D.workerOf(target);
      if (thread === null) {
        throw new TypeError(
          "Failed to construct 'RTCRtpScriptTransform': parameter 1 is not of type 'Worker'.",
        );
      }
      const n = ++transforms;
      D.post(target, n, options, transfer);
      slots.set(this, { what: 'transform', n, thread, owner: null });
    }
  }
  webIdl(RTCRtpScriptTransform);

  const isTransform = (v: Any): boolean => slots.get(v)?.what === 'transform';
  const attach = (
    transform: Any,
    owner: Any,
    tx: number,
    side: 'sender' | 'receiver',
  ): void => {
    const s = slotOf(transform, 'transform');
    // a transform once used is its sender's or its receiver's for good,
    // taken off it or not ([[used]], 4.4)
    if (s.owner && s.owner !== owner) {
      throw new DOMException(
        'The transform is already in use by another sender or receiver.',
        'InvalidStateError',
      );
    }
    s.owner = owner;
    call('rtcTransform', tx, side, s.n, s.thread);
  };

  return {
    interfaces: {
      RTCRtpScriptTransform,
      RTCRtpScriptTransformer,
      RTCTransformEvent,
      RTCEncodedVideoFrame,
      RTCEncodedAudioFrame,
    },
    isTransform,
    attach,
    isFrame: (v: Any) => slots.get(v)?.what === 'frame',
    partsOf: (frame: Any) => {
      const s = slotOf(frame, 'frame');
      if (detached(s.data)) {
        throw new DOMException(
          'An encoded frame whose data was transferred could not be cloned.',
          'DataCloneError',
        );
      }
      return {
        kind: s.kind,
        type: s.type,
        metadata: copyMetadata(s.metadata, s.kind),
        data: s.data,
      };
    },
    make: (kind, type, metadata, data) =>
      make(kind === 'audio' ? 'audio' : 'video', type, metadata, data),
    arrived,
  };
}
