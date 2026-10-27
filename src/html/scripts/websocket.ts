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
  const Event: Any = D.Event;
  const MessageEvent: Any = D.MessageEvent;
  const Blob: Any = D.Blob;
  const URLClass: Any = D.URL;
  const fire: Any = D.fire;
  const base64OfBytes: Any = D.base64OfBytes;
  const bytesOfBase64: Any = D.bytesOfBase64;

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
      // the URL, as "get a URL record" has it
      const text = usv(url);
      let parsed: Any;
      try {
        parsed = new URLClass(text, D.base());
      } catch {
        throw domError(
          `Failed to construct 'WebSocket': The URL '${text}' is invalid.`,
          'SyntaxError',
        );
      }
      let href = String(parsed.href);
      const scheme = String(parsed.protocol);
      if (scheme === 'http:') href = 'ws' + href.slice(4);
      else if (scheme === 'https:') href = 'wss' + href.slice(5);
      else if (scheme !== 'ws:' && scheme !== 'wss:') {
        throw domError(
          `Failed to construct 'WebSocket': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${scheme.slice(0, -1)}' is not allowed.`,
          'SyntaxError',
        );
      }
      if (href.includes('#')) {
        throw domError(
          `Failed to construct 'WebSocket': The URL contains a fragment identifier ('${href.slice(href.indexOf('#'))}'). Fragment identifiers are not allowed in WebSocket URLs.`,
          'SyntaxError',
        );
      }
      // the protocols: tokens, none twice whatever its case
      const list = protocolsOf(protocols, true);
      const seen = new Set<string>();
      for (const protocol of list) {
        if (!PROTOCOL.test(protocol)) {
          throw domError(
            `Failed to construct 'WebSocket': The subprotocol '${protocol}' is invalid.`,
            'SyntaxError',
          );
        }
        const key = protocol.toLowerCase();
        if (seen.has(key)) {
          throw domError(
            `Failed to construct 'WebSocket': The subprotocol '${protocol}' is duplicated.`,
            'SyntaxError',
          );
        }
        seen.add(key);
      }
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
      this._handlers[name] = isObject(fn) ? fn : null;
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

  // --- what the host tells -------------------------------------------------

  // the opening handshake succeeded: OPEN, and what the server chose
  entry('__wsOpen', () => {
    const [id, protocol, extensions] = input() as [number, string, string];
    const s = sockets.get(id);
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

  const interfaces: Record<string, Any> = { WebSocket, CloseEvent };
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
