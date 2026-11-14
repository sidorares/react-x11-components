// The WHATWG WebSockets standard, as a page's scripts see it: `WebSocket`
// and `CloseEvent`.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` is handed it and calls it
// with what it reaches the host by.
//
// The network's half is the host's (`sockets.ts`, over the
// `HtmlScripts.webSocket` seam): a socket is a number, and what crosses
// either way is primitives — a binary message as base64. The host tells
// what became of a socket through entries (`__ws…`), and the page never
// asks: the state a page reads — `readyState`, `bufferedAmount`,
// `protocol` — is kept here, as the standard keeps it on the object. So
// is everything a page is handed, the events and the errors, made of this
// realm's own classes.

/** What `installDom` hands this. */
export interface WebSocketDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  DOMException: unknown;
  EventTarget: unknown;
  /** Sets a target's `on<type>` handler, which takes its place among
   *  its listeners as it is first set (HTML 8.1.8.1). */
  setHandler(target: unknown, type: string, value: unknown): void;
  Event: unknown;
  MessageEvent: unknown;
  Blob: unknown;
  URL: unknown;
  /** The API base URL a socket's URL is parsed against: the document's
   *  base, or a worker's address. */
  base(): string;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  base64OfBytes(bytes: Uint8Array): string;
  bytesOfBase64(text: string): Uint8Array;
  /** The realm's streams, which a `WebSocketStream`'s readable and
   *  writable are made by (`streams.ts`). */
  streams?: unknown;
  AbortSignal?: unknown;
  /** A task, `ms` from now. */
  setTimer?(fn: () => void, ms: number): unknown;
}

export function installWebSocket(deps: WebSocketDeps): Record<string, unknown> {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const call: Any = D.call;
  const entry: Any = D.entry;
  const input: Any = D.input;
  const DOMException: Any = D.DOMException;
  const EventTarget: Any = D.EventTarget;
  const setHandler: Any = D.setHandler;
  const Event: Any = D.Event;
  const MessageEvent: Any = D.MessageEvent;
  const Blob: Any = D.Blob;
  const URLClass: Any = D.URL;
  const fire: Any = D.fire;
  const base64OfBytes: Any = D.base64OfBytes;
  const bytesOfBase64: Any = D.bytesOfBase64;
  const streams: Any = D.streams;
  const AbortSignalClass: Any = D.AbortSignal;
  const later = (fn: () => void): void => {
    if (D.setTimer) D.setTimer(fn, 0);
    else Promise.resolve().then(fn);
  };
  const resizableOf: Any = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'resizable',
  )?.get;
  const sabByteLength: Any =
    typeof SharedArrayBuffer === 'function'
      ? Object.getOwnPropertyDescriptor(
          SharedArrayBuffer.prototype,
          'byteLength',
        )?.get
      : undefined;
  /** Whether a buffer is one a `BufferSource` takes no view of: shared,
   *  or resizable (Web IDL 3.2.24, no [AllowShared] or [AllowResizable]). */
  const unacceptedBuffer = (buffer: Any): boolean => {
    if (!isObject(buffer)) return false;
    if (sabByteLength) {
      try {
        apply(sabByteLength, buffer, []);
        return true;
      } catch {
        // not shared
      }
    }
    try {
      return !!(resizableOf && apply(resizableOf, buffer, []));
    } catch {
      return false;
    }
  };

  const apply: Any = Reflect.apply;
  const WM: Any = WeakMap;
  const wmGet: Any = WM.prototype.get;
  const wmSet: Any = WM.prototype.set;
  const stringify: Any = JSON.stringify;
  const isView: Any = ArrayBuffer.isView;
  const abByteLength: Any = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
  )!.get;
  const U8: Any = Uint8Array;
  const iterator = Symbol.iterator;

  const typeError = (message: string): Any => new TypeError(message);
  const domError = (message: string, name: string): Any =>
    new DOMException(message, name);
  const illegal = (): Any => typeError('Illegal invocation');
  const isObject = (v: Any): boolean =>
    (typeof v === 'object' && v !== null) || typeof v === 'function';

  const slots = new WM();
  const slotOf = (self: Any, tag: string): Any => {
    const s = isObject(self) ? apply(wmGet, slots, [self]) : null;
    if (!s || !s[tag]) throw illegal();
    return s;
  };

  // --- Web IDL's conversions -----------------------------------------------

  /** `USVString`: a lone surrogate is U+FFFD. */
  const usv = (v: Any): string => {
    const text = String(v);
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += text[i] + text[i + 1];
          i += 1;
        } else out += '�';
      } else if (c >= 0xdc00 && c <= 0xdfff) out += '�';
      else out += text[i];
    }
    return out;
  };
  /** The UTF-8 length of a well-formed string. */
  const utf8Length = (text: string): number => {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) {
        n += 4;
        i += 1;
      } else n += 3;
    }
    return n;
  };
  /** `[Clamp] unsigned short`: rounded half to even, into [0, 65535]. */
  const clampShort = (v: Any): number => {
    const n = Number(v);
    if (Number.isNaN(n)) return 0;
    const x = Math.min(Math.max(n, 0), 65535);
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  };
  /** `unsigned short`, modulo 2^16. */
  const uint16 = (v: Any): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    const t = Math.trunc(n) % 65536;
    return t < 0 ? t + 65536 : t;
  };
  /** An ArrayBuffer's bytes, of any realm's, or null for anything else. */
  const bufferBytes = (v: Any): Uint8Array | null => {
    if (!isObject(v)) return null;
    try {
      apply(abByteLength, v, []);
    } catch {
      return null;
    }
    return new U8(v);
  };

  /** What `Sec-WebSocket-Protocol` carries an element of: an RFC 2616
   *  token, U+0021 to U+007E but the separators (RFC 6455 4.1). */
  const PROTOCOL = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

  /** `(sequence<DOMString> or DOMString)`, the constructor's second
   *  argument — or an option bag that holds one in `protocols`, as WPT's
   *  `constructor/option-bag.any.js` has it. */
  const protocolsOf = (value: Any, bag: boolean): string[] => {
    if (value === undefined) return [];
    if (isObject(value)) {
      const each = value[iterator];
      if (typeof each === 'function') {
        const out: string[] = [];
        const it: Any = apply(each, value, []);
        for (let step = it.next(); !step.done; step = it.next()) {
          out.push(String(step.value));
        }
        return out;
      }
      if (bag) return protocolsOf(value.protocols, false);
    }
    return [String(value)];
  };

  /** A socket's URL, as "get a URL record" has it, for the constructor of
   *  `what`: `http` and `https` are `ws` and `wss`, and no fragment. */
  const socketUrl = (url: Any, what: string): string => {
    const text = usv(url);
    let parsed: Any;
    try {
      parsed = new URLClass(text, D.base());
    } catch {
      throw domError(
        `Failed to construct '${what}': The URL '${text}' is invalid.`,
        'SyntaxError',
      );
    }
    let href = String(parsed.href);
    const scheme = String(parsed.protocol);
    if (scheme === 'http:') href = 'ws' + href.slice(4);
    else if (scheme === 'https:') href = 'wss' + href.slice(5);
    else if (scheme !== 'ws:' && scheme !== 'wss:') {
      throw domError(
        `Failed to construct '${what}': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${scheme.slice(0, -1)}' is not allowed.`,
        'SyntaxError',
      );
    }
    if (href.includes('#')) {
      throw domError(
        `Failed to construct '${what}': The URL contains a fragment identifier ('${href.slice(href.indexOf('#'))}'). Fragment identifiers are not allowed in WebSocket URLs.`,
        'SyntaxError',
      );
    }
    return href;
  };
  /** The protocols, tokens and none twice whatever its case. */
  const checkedProtocols = (list: string[], what: string): string[] => {
    const seen = new Set<string>();
    for (const protocol of list) {
      if (!PROTOCOL.test(protocol)) {
        throw domError(
          `Failed to construct '${what}': The subprotocol '${protocol}' is invalid.`,
          'SyntaxError',
        );
      }
      const key = protocol.toLowerCase();
      if (seen.has(key)) {
        throw domError(
          `Failed to construct '${what}': The subprotocol '${protocol}' is duplicated.`,
          'SyntaxError',
        );
      }
      seen.add(key);
    }
    return list;
  };

  // --- CloseEvent ----------------------------------------------------------

  class CloseEvent extends Event {
    constructor(type: Any, init: Any = undefined) {
      if (arguments.length < 1) {
        throw typeError(
          "Failed to construct 'CloseEvent': 1 argument required, but only 0 present.",
        );
      }
      if (init !== undefined && init !== null && !isObject(init)) {
        throw typeError(
          "Failed to construct 'CloseEvent': The provided value is not of type 'CloseEventInit'.",
        );
      }
      const i = init ?? {};
      super(type, i);
      // a dictionary's members are read in their names' order
      const code = i.code;
      const reason = i.reason;
      const wasClean = i.wasClean;
      apply(wmSet, slots, [
        this,
        {
          closeEvent: true,
          code: code === undefined ? 0 : uint16(code),
          reason: reason === undefined ? '' : usv(reason),
          wasClean: !!wasClean,
        },
      ]);
    }
    get wasClean(): boolean {
      return slotOf(this, 'closeEvent').wasClean;
    }
    get code(): number {
      return slotOf(this, 'closeEvent').code;
    }
    get reason(): string {
      return slotOf(this, 'closeEvent').reason;
    }
  }

  // --- WebSocket -----------------------------------------------------------

  const STATES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
  /** Each socket the host may still tell of, by its number. */
  const sockets = new Map<number, Any>();
  let seq = 0;

  class WebSocket extends EventTarget {
    constructor(url: Any, protocols: Any = undefined) {
      if (arguments.length < 1) {
        throw typeError(
          "Failed to construct 'WebSocket': 1 argument required, but only 0 present.",
        );
      }
      const href = socketUrl(url, 'WebSocket');
      const list = checkedProtocols(protocolsOf(protocols, true), 'WebSocket');
      super();
      const id = ++seq;
      const s = {
        socket: true,
        self: this,
        id,
        url: href,
        // a message's `origin` (WebSockets, "a WebSocket message has been
        // received")
        origin: String(new URLClass(href).origin),
        readyState: 0,
        bufferedAmount: 0,
        protocol: '',
        extensions: '',
        binaryType: 'blob',
      };
      apply(wmSet, slots, [this, s]);
      sockets.set(id, s);
      call('wsOpen', id, href, stringify(list));
    }
    get url(): string {
      return slotOf(this, 'socket').url;
    }
    get readyState(): number {
      return slotOf(this, 'socket').readyState;
    }
    get bufferedAmount(): number {
      return slotOf(this, 'socket').bufferedAmount;
    }
    get extensions(): string {
      return slotOf(this, 'socket').extensions;
    }
    get protocol(): string {
      return slotOf(this, 'socket').protocol;
    }
    get binaryType(): string {
      return slotOf(this, 'socket').binaryType;
    }
    set binaryType(value: Any) {
      const s = slotOf(this, 'socket');
      const type = String(value);
      // an enumeration's other values are ignored (Web IDL 3.2.20)
      if (type === 'blob' || type === 'arraybuffer') s.binaryType = type;
    }
    close(code: Any = undefined, reason: Any = undefined): void {
      const s = slotOf(this, 'socket');
      let status: number | null = null;
      if (code !== undefined) {
        status = clampShort(code);
        if (status !== 1000 && (status < 3000 || status > 4999)) {
          throw domError(
            `Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${status} is neither.`,
            'InvalidAccessError',
          );
        }
      }
      let why = '';
      if (reason !== undefined) {
        why = usv(reason);
        if (utf8Length(why) > 123) {
          throw domError(
            "Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.",
            'SyntaxError',
          );
        }
      }
      if (s.readyState === 2 || s.readyState === 3) return;
      // before it is established, the connection is failed; after, the
      // closing handshake starts, with 1000 where only a reason was given
      if (s.readyState === 1 && status === null && reason !== undefined) {
        status = 1000;
      }
      s.readyState = 2;
      call('wsClose', s.id, status, why);
    }
    send(data: Any): void {
      const s = slotOf(this, 'socket');
      if (arguments.length < 1) {
        throw typeError(
          "Failed to execute 'send' on 'WebSocket': 1 argument required, but only 0 present.",
        );
      }
      if (s.readyState === 0) {
        throw domError(
          "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
          'InvalidStateError',
        );
      }
      // `(BufferSource or Blob or USVString)`, its bytes taken now, so a
      // page that writes into its buffer after sends what it sent
      let bytes: Uint8Array | null = bufferBytes(data);
      if (!bytes && isView(data)) {
        bytes = new U8(data.buffer, data.byteOffset, data.byteLength);
      } else if (!bytes && Blob && data instanceof Blob && data._bytes) {
        bytes = data._bytes;
      }
      const text = bytes ? '' : usv(data);
      const size = bytes ? bytes.byteLength : utf8Length(text);
      // what is sent once the closing handshake has started is only
      // counted (WebSockets, `send()`)
      s.bufferedAmount += size;
      if (s.readyState !== 1) return;
      if (bytes) call('wsSend', s.id, true, base64OfBytes(bytes), size);
      else call('wsSend', s.id, false, text, size);
    }
  }
  for (const on of [WebSocket, WebSocket.prototype]) {
    STATES.forEach((name, value) =>
      Object.defineProperty(on, name, {
        value,
        writable: false,
        enumerable: true,
        configurable: false,
      }),
    );
  }
  /** An event handler IDL attribute, its accessors named as Web IDL names
   *  them: what is not an object is null ([LegacyTreatNonObjectAsNull]). */
  for (const name of ['open', 'error', 'close', 'message']) {
    const get = function (this: Any) {
      slotOf(this, 'socket');
      return this._handlers[name] ?? null;
    };
    const set = function (this: Any, fn: Any) {
      slotOf(this, 'socket');
      setHandler(this, name, isObject(fn) ? fn : null);
    };
    Object.defineProperty(get, 'name', { value: `get on${name}` });
    Object.defineProperty(set, 'name', { value: `set on${name}` });
    Object.defineProperty(WebSocket.prototype, 'on' + name, {
      get,
      set,
      enumerable: true,
      configurable: true,
    });
  }

  // --- WebSocketError and WebSocketStream ----------------------------------
  //
  // The WebSocketStream explainer and WPT's `websockets/stream/tentative/`:
  // a socket whose messages are a readable stream and whose sends are a
  // writable one, its opening and its closing promises. Over the same host
  // half as `WebSocket` (the `ws…` ops, the `__ws…` entries), its socket
  // told apart by `stream`.

  const PromiseClass: Any = Promise;
  const promiseThen: Any = Promise.prototype.then;
  /** A promise and its two settlers; marked handled, as the explainer
   *  marks `opened` and `closed`, so one nobody waits on reports nothing. */
  const deferred = (): Any => {
    let resolve: Any;
    let reject: Any;
    const promise = new PromiseClass((ok: Any, fail: Any) => {
      resolve = ok;
      reject = fail;
    });
    apply(promiseThen, promise, [undefined, () => undefined]);
    return { promise, resolve, reject };
  };

  /** A close's code and reason, from a dictionary of `closeCode` and
   *  `reason`, checked as `close()` checks them: a reason with no code is
   *  sent with 1000, and nothing with none. */
  const closeInfo = (
    init: Any,
    what: string,
  ): { code: Any; reason: string } => {
    if (init !== undefined && init !== null && !isObject(init)) {
      throw typeError(
        `Failed to execute '${what}': The provided value is not of type 'WebSocketCloseInfo'.`,
      );
    }
    const i = init ?? {};
    const closeCode = i.closeCode;
    const reasonIn = i.reason;
    let code: Any = null;
    if (closeCode !== undefined) {
      code = clampShort(closeCode);
      if (code !== 1000 && (code < 3000 || code > 4999)) {
        throw domError(
          `Failed to execute '${what}': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
          'InvalidAccessError',
        );
      }
    }
    const reason = reasonIn === undefined ? '' : usv(reasonIn);
    if (utf8Length(reason) > 123) {
      throw domError(
        `Failed to execute '${what}': The close reason must not be greater than 123 UTF-8 bytes.`,
        'SyntaxError',
      );
    }
    if (code === null && reason !== '') code = 1000;
    return { code, reason };
  };

  class WebSocketError extends DOMException {
    constructor(message: Any = '', init: Any = undefined) {
      const { code, reason } = closeInfo(init, 'WebSocketError');
      super(message === undefined ? '' : String(message), 'WebSocketError');
      apply(wmSet, slots, [this, { wsError: true, closeCode: code, reason }]);
    }
    get closeCode(): number | null {
      return slotOf(this, 'wsError').closeCode;
    }
    get reason(): string {
      return slotOf(this, 'wsError').reason;
    }
  }
  /** A `WebSocketError` the user agent makes, its code whatever came. */
  const socketError = (message: string, code: Any, reason: string): Any => {
    const e = new WebSocketError(message);
    const slot = apply(wmGet, slots, [e]);
    slot.closeCode = code;
    slot.reason = reason;
    return e;
  };
  /** What an abort or a cancel closes with: a `WebSocketError`'s code and
   *  reason, and nothing for any other reason. */
  const reasonCode = (reason: Any): [Any, string] => {
    const slot = isObject(reason) ? apply(wmGet, slots, [reason]) : null;
    return slot?.wsError ? [slot.closeCode, slot.reason] : [null, ''];
  };

  // a readable stream's default controller's methods, taken before any
  // page code can put its own there
  let enqueueOf: Any = null;
  let closeOf: Any = null;
  if (streams) {
    const probe = streams.readable(
      () => undefined,
      () => PromiseClass.resolve(),
      () => PromiseClass.resolve(),
    );
    const proto = Object.getPrototypeOf(streams.controllerOf(probe));
    enqueueOf = proto.enqueue;
    closeOf = proto.close;
  }

  class WebSocketStream {
    constructor(url: Any, options: Any = undefined) {
      if (arguments.length < 1) {
        throw typeError(
          "Failed to construct 'WebSocketStream': 1 argument required, but only 0 present.",
        );
      }
      if (options !== undefined && options !== null && !isObject(options)) {
        throw typeError(
          "Failed to construct 'WebSocketStream': The provided value is not of type 'WebSocketStreamOptions'.",
        );
      }
      const o = options ?? {};
      // a dictionary's members in their names' order
      const protocolsIn = o.protocols;
      const signal = o.signal;
      let list: string[] = [];
      if (protocolsIn !== undefined) {
        if (
          !isObject(protocolsIn) ||
          typeof protocolsIn[iterator] !== 'function'
        ) {
          throw typeError(
            "Failed to construct 'WebSocketStream': The provided value cannot be converted to a sequence.",
          );
        }
        list = protocolsOf(protocolsIn, false);
      }
      if (
        signal !== undefined &&
        !(AbortSignalClass && signal instanceof AbortSignalClass)
      ) {
        throw typeError(
          "Failed to construct 'WebSocketStream': Failed to read the 'signal' property from 'WebSocketStreamOptions': Failed to convert value to 'AbortSignal'.",
        );
      }
      const href = socketUrl(url, 'WebSocketStream');
      checkedProtocols(list, 'WebSocketStream');
      const id = ++seq;
      const s: Any = {
        stream: true,
        self: this,
        id,
        url: href,
        state: 'connecting',
        opened: deferred(),
        closed: deferred(),
        aborted: false,
        readable: null,
        writable: null,
        /** Writes waiting for their bytes to go: how many are left of each. */
        writes: [] as Any[],
        closing: null as Any,
      };
      apply(wmSet, slots, [this, s]);
      if (signal?.aborted) {
        s.aborted = true;
        s.state = 'closed';
        s.opened.reject(signal.reason);
        s.closed.reject(signal.reason);
        return;
      }
      sockets.set(id, s);
      call('wsOpen', id, href, stringify(list));
      if (signal) {
        signal.addEventListener('abort', () => {
          if (s.state !== 'connecting') return;
          s.aborted = true;
          s.state = 'closed';
          sockets.delete(id);
          call('wsClose', id, null, '');
          s.opened.reject(signal.reason);
          s.closed.reject(signal.reason);
        });
      }
    }
    get url(): string {
      return slotOf(this, 'stream').url;
    }
    get opened(): Any {
      return slotOf(this, 'stream').opened.promise;
    }
    get closed(): Any {
      return slotOf(this, 'stream').closed.promise;
    }
    close(closeInfoIn: Any = undefined): void {
      const s = slotOf(this, 'stream');
      const { code, reason } = closeInfo(
        closeInfoIn,
        "close' on 'WebSocketStream",
      );
      streamClose(s, code, reason);
    }
  }

  /** Start a stream's closing handshake, or fail its connection where it
   *  has none yet; nothing once it is closing, or was aborted. */
  const streamClose = (s: Any, code: Any, reason: string): void => {
    if (s.aborted || s.state === 'closing' || s.state === 'closed') return;
    s.state = 'closing';
    call('wsClose', s.id, code, reason);
  };

  /** The opening handshake succeeded: a readable of the messages, a
   *  writable of the sends. */
  const streamOpened = (s: Any, protocol: string, extensions: string): void => {
    s.state = 'open';
    s.readable = streams.readable(
      () => undefined,
      () => PromiseClass.resolve(),
      (reason: Any) => {
        const [code, why] = reasonCode(reason);
        streamClose(s, code, why);
        return PromiseClass.resolve();
      },
      1,
    );
    s.writable = streams.writable(
      () => undefined,
      (chunk: Any) => {
        if (s.state !== 'open') {
          return PromiseClass.reject(
            domError('The WebSocket is not open.', 'InvalidStateError'),
          );
        }
        // a `BufferSource`, or anything else as a `USVString`, either of
        // which a write rejects where it is not one
        let bytes: Uint8Array | null = bufferBytes(chunk);
        let text = '';
        try {
          if (bytes && unacceptedBuffer(chunk)) {
            throw typeError('A resizable or shared buffer cannot be sent.');
          }
          if (!bytes && isView(chunk)) {
            if (unacceptedBuffer(chunk.buffer)) {
              throw typeError(
                'A view on a resizable or shared buffer cannot be sent.',
              );
            }
            bytes = new U8(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          }
          if (!bytes) text = usv(chunk);
        } catch (e) {
          return PromiseClass.reject(e);
        }
        const size = bytes ? bytes.byteLength : utf8Length(text);
        const write = deferred();
        if (size === 0) write.resolve();
        else s.writes.push({ left: size, done: write });
        if (bytes) call('wsSend', s.id, true, base64OfBytes(bytes), size);
        else call('wsSend', s.id, false, text, size);
        return write.promise;
      },
      () => {
        const done = deferred();
        s.closing = done;
        streamClose(s, null, '');
        return done.promise;
      },
      (reason: Any) => {
        const [code, why] = reasonCode(reason);
        streamClose(s, code, why);
        return PromiseClass.resolve();
      },
      1,
    );
    s.opened.resolve({
      readable: s.readable,
      writable: s.writable,
      extensions,
      protocol,
    });
  };

  /** The connection closed: `closed` settles, and the two streams end, a
   *  task later, so that a page that waits on `closed` has its handlers on
   *  its writes before they reject. What was still to be sent makes the
   *  close unclean, and is what the writable is errored with. */
  const streamClosedNow = (
    s: Any,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void => {
    if (s.aborted) return;
    s.state = 'closed';
    if (!s.readable) {
      // never opened: its handshake failed, or a close failed it
      const e = socketError(
        'The WebSocket connection could not be established.',
        null,
        '',
      );
      s.opened.reject(e);
      s.closed.reject(e);
      return;
    }
    const clean = wasClean && !s.writes.length;
    const e = clean
      ? null
      : socketError(
          'The WebSocket connection was closed uncleanly.',
          code,
          reason,
        );
    if (clean) {
      try {
        apply(closeOf, streams.controllerOf(s.readable), []);
      } catch {
        // cancelled, or closed already
      }
      s.closed.resolve({ closeCode: code, reason });
    } else {
      streams.errorReadable(s.readable, e);
      s.closed.reject(e);
    }
    // the writable errored at once, as a page that waits on `closed` finds
    // it, and a write still in flight with the error it keeps: what it
    // rejects with comes a task later, its handlers on it by then
    const stopped = domError('The WebSocket is closed.', 'InvalidStateError');
    const writes = s.writes;
    s.writes = [];
    if (s.closing && !writes.length) {
      const closing = s.closing;
      if (clean) closing.resolve();
      else later(() => closing.reject(e));
    } else {
      streams.errorWritable(
        s.writable,
        writes.length ? stopped : (e ?? stopped),
      );
      if (writes.length)
        later(() => writes.forEach((w: Any) => w.done.reject(stopped)));
    }
  };

  // --- what the host tells -------------------------------------------------

  // the opening handshake succeeded: OPEN, and what the server chose
  entry('__wsOpen', () => {
    const [id, protocol, extensions] = input() as [number, string, string];
    const s = sockets.get(id);
    if (s?.stream) {
      if (s.state === 'connecting') {
        streamOpened(s, String(protocol ?? ''), String(extensions ?? ''));
      }
      return null;
    }
    if (!s || s.readyState !== 0) return null;
    s.readyState = 1;
    s.protocol = String(protocol ?? '');
    s.extensions = String(extensions ?? '');
    fire(s.self, new Event('open'));
    return null;
  });
  // a message, which only an OPEN socket hears
  entry('__wsMessage', () => {
    const [id, binary, payload] = input() as [number, boolean, string];
    const s = sockets.get(id);
    if (s?.stream) {
      if (s.state !== 'open' || !s.readable) return null;
      const chunk = binary
        ? new U8(bytesOfBase64(String(payload)))
        : String(payload);
      try {
        apply(enqueueOf, streams.controllerOf(s.readable), [chunk]);
      } catch {
        // cancelled: nothing reads on
      }
      return null;
    }
    if (!s || s.readyState !== 1) return null;
    let data: Any = String(payload);
    if (binary) {
      const bytes = bytesOfBase64(data);
      data =
        s.binaryType === 'blob' && Blob
          ? new Blob([bytes])
          : bytes.slice().buffer;
    }
    fire(s.self, new MessageEvent('message', { data, origin: s.origin }));
    return null;
  });
  // bytes handed to the network, which `bufferedAmount` comes down by
  entry('__wsSent', () => {
    const [id, bytes] = input() as [number, number];
    const s = sockets.get(id);
    if (!s) return null;
    if (s.stream) {
      // each write is done once all its bytes have gone
      let left = Number(bytes);
      while (left > 0 && s.writes.length) {
        const w = s.writes[0];
        const take = Math.min(left, w.left);
        w.left -= take;
        left -= take;
        if (w.left > 0) break;
        s.writes.shift();
        w.done.resolve();
      }
      return null;
    }
    s.bufferedAmount = Math.max(0, s.bufferedAmount - Number(bytes));
    return null;
  });
  // the connection closed: CLOSED, `error` where it was failed, and
  // `close` with how (WebSockets, "the WebSocket connection is closed")
  entry('__wsClosed', () => {
    const [id, code, reason, wasClean, failed] = input() as [
      number,
      number,
      string,
      boolean,
      boolean,
    ];
    const s = sockets.get(id);
    if (!s) return null;
    sockets.delete(id);
    if (s.stream) {
      streamClosedNow(s, Number(code), String(reason ?? ''), !!wasClean);
      return null;
    }
    s.readyState = 3;
    if (failed) fire(s.self, new Event('error'));
    fire(
      s.self,
      new CloseEvent('close', {
        wasClean: !!wasClean,
        code: Number(code),
        reason: String(reason ?? ''),
      }),
    );
    return null;
  });

  const interfaces: Record<string, Any> = streams
    ? { WebSocket, CloseEvent, WebSocketStream, WebSocketError }
    : { WebSocket, CloseEvent };
  // Web IDL's: members enumerable, and objects' class strings their names
  for (const name of Object.getOwnPropertyNames(interfaces)) {
    const C = interfaces[name];
    for (const key of Object.getOwnPropertyNames(C.prototype)) {
      if (key === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(C.prototype, key)!;
      if (d.enumerable || (!d.get && typeof d.value !== 'function')) continue;
      Object.defineProperty(C.prototype, key, { ...d, enumerable: true });
    }
    Object.defineProperty(C.prototype, Symbol.toStringTag, {
      value: name,
      configurable: true,
    });
  }
  return interfaces;
}
