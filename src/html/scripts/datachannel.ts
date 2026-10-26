// WebRTC 1.0's data channels, as a page's scripts see them:
// `RTCDataChannel`, `RTCDataChannelEvent` and `RTCSctpTransport`, over the
// host's channels (`peers.ts`: the `rtcChannel`, `rtcSend` and
// `rtcCloseChannel` ops, the `__rtcChannel` entry). `webrtc.ts`'s
// `RTCPeerConnection` makes them through the internals this answers.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing.
//
// A channel is a number for the host's, and its messages cross as text or
// base64. A channel can be handed to a dedicated worker in the task that
// made it (`transferOut`, `adopt`): the worker's realm makes one of its own
// for the same number, and the host carries its ops and its events across
// the worker's thread (`peers.ts`, `ChannelRelay`).

/** What `installDom` hands this. */
export interface DataChannelsDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  DOMException: unknown;
  EventTarget: unknown;
  Event: unknown;
  MessageEvent: unknown;
  Blob: unknown;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  bytesOfBase64(text: string): Uint8Array;
  base64OfBytes(bytes: Uint8Array): string;
  /** An `RTCErrorEvent` named `error`, for a channel that failed: made by
   *  `webrtc.ts`, which is installed after this. */
  errorEvent(detail: unknown, message: string): unknown;
  /** Runs `fn` in a task of its own, after this one. */
  later(fn: () => void): void;
}

/** What `webrtc.ts` reaches data channels through. A connection is its
 *  slot there: `id`, `self` and `closed` are read. */
export interface DataChannelsInternals {
  interfaces: Record<string, unknown>;
  /** `createDataChannel(label, init)`, checked as it checks them. */
  create(connection: unknown, label: unknown, init: unknown): unknown;
  /** The peer opened a channel: `datachannel`, then `open`. */
  remote(connection: unknown, channel: number, init: unknown): void;
  /** A description negotiated data channels over `dtls`. */
  sctpNegotiated(connection: unknown, sctp: unknown, dtls?: unknown): void;
  /** The SCTP transport's state moved. */
  sctpState(connection: unknown, state: unknown): void;
  /** `pc.sctp`. */
  sctpOf(connection: unknown): unknown;
  /** The connection closed: every channel is closed, with no events. */
  closeAll(connection: unknown): void;
  /** Whether a value is one of this realm's channels. */
  isChannel(value: unknown): boolean;
  /** Whether a channel may still be transferred: only in the task that
   *  made it, and not once it has sent. */
  transferable(channel: unknown): boolean;
  /** A channel as it crosses to a worker: its number and its state. */
  transferData(channel: unknown): { host: number; state: unknown };
  /** Hands a channel to a worker: the host tells the worker of it from now
   *  on, and this one is closed, with no events. */
  transferOut(channel: unknown, worker: number): void;
  /** A channel a page handed this realm, a worker's. */
  adopt(host: number, state: unknown): unknown;
}

export function installDataChannels(
  deps: DataChannelsDeps,
): DataChannelsInternals {
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
  const fire: Any = D.fire;
  const bytesOfBase64: Any = D.bytesOfBase64;
  const base64OfBytes: Any = D.base64OfBytes;

  const apply: Any = Reflect.apply;
  const WM: Any = WeakMap;
  const wmGet: Any = WM.prototype.get;
  const wmSet: Any = WM.prototype.set;
  const stringify: Any = JSON.stringify;
  const isView: Any = ArrayBuffer.isView;
  const U8: Any = Uint8Array;
  const TOKEN = Object.freeze(Object.create(null));

  const typeError = (message: string): Any => new TypeError(message);
  const domError = (message: string, name: string): Any =>
    new DOMException(message, name);
  const illegal = (): Any => typeError('Illegal invocation');
  const illegalConstructor = (): Any => typeError('Illegal constructor');

  const slots = new WM();
  const slotOf = (self: Any, tag: string): Any => {
    const s =
      self && typeof self === 'object' ? apply(wmGet, slots, [self]) : null;
    if (!s || !s[tag]) throw illegal();
    return s;
  };
  /** An event handler IDL attribute, its accessors named as Web IDL
   *  names them. */
  const handler = (proto: Any, name: string): void => {
    const get = function (this: Any) {
      return this._handlers[name] ?? null;
    };
    const set = function (this: Any, fn: Any) {
      this._handlers[name] =
        typeof fn === 'function' || (typeof fn === 'object' && fn) ? fn : null;
    };
    Object.defineProperty(get, 'name', { value: `get on${name}` });
    Object.defineProperty(set, 'name', { value: `set on${name}` });
    Object.defineProperty(proto, 'on' + name, {
      get,
      set,
      enumerable: true,
      configurable: true,
    });
  };
  /** Classes made Web IDL interfaces: their members enumerable, as IDL's
   *  are, and their objects' class strings their names. */
  const idl = (classes: Record<string, Any>): void => {
    for (const name of Object.getOwnPropertyNames(classes)) {
      const C = classes[name];
      for (const on of [C.prototype, C]) {
        for (const key of Object.getOwnPropertyNames(on)) {
          if (['constructor', 'prototype', 'length', 'name'].includes(key)) {
            continue;
          }
          const d = Object.getOwnPropertyDescriptor(on, key)!;
          if (d.enumerable || (!d.get && typeof d.value !== 'function')) {
            continue;
          }
          Object.defineProperty(on, key, { ...d, enumerable: true });
        }
      }
      Object.defineProperty(C.prototype, Symbol.toStringTag, {
        value: name,
        configurable: true,
      });
    }
  };
  const simple = (target: Any, type: string): void =>
    fire(target, new Event(type));

  const utf8Length = (text: string): number => {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
        n += 4;
        i += 1;
      } else n += 3;
    }
    return n;
  };
  /** Web IDL's `[EnforceRange] unsigned short`. */
  const enforceShort = (value: Any, what: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw typeError(`${what} is not a finite number.`);
    const t = Math.trunc(n);
    if (t < 0 || t > 65535) {
      throw typeError(`${what} is outside the range [0, 65535].`);
    }
    return t;
  };

  /** The bytes a channel's sends may have waiting: Chrome's 16 MiB. */
  const SEND_BUFFER = 16 * 1024 * 1024;

  /** Each connection's channels and SCTP transport, by its slot. */
  const byConnection = new WM();
  const stateOf = (pc: Any): Any => {
    let s = apply(wmGet, byConnection, [pc]);
    if (!s) {
      s = { channels: new Set(), sctp: null };
      apply(wmSet, byConnection, [pc, s]);
    }
    return s;
  };
  /** Each channel by the host's number. */
  const channels = new Map<number, Any>();

  class RTCSctpTransport extends EventTarget {
    constructor(token: Any = undefined) {
      super();
      if (token !== TOKEN) throw illegalConstructor();
    }
    get transport(): Any {
      return slotOf(this, 'sctp').dtls;
    }
    get state(): string {
      return slotOf(this, 'sctp').state;
    }
    get maxMessageSize(): number {
      return slotOf(this, 'sctp').maxMessageSize;
    }
    get maxChannels(): Any {
      return slotOf(this, 'sctp').maxChannels;
    }
  }
  handler(RTCSctpTransport.prototype, 'statechange');

  class RTCDataChannel extends EventTarget {
    constructor(token: Any = undefined) {
      super();
      if (token !== TOKEN) throw illegalConstructor();
    }
    get label(): string {
      return slotOf(this, 'channel').label;
    }
    get ordered(): boolean {
      return slotOf(this, 'channel').ordered;
    }
    get maxPacketLifeTime(): Any {
      return slotOf(this, 'channel').maxPacketLifeTime;
    }
    get maxRetransmits(): Any {
      return slotOf(this, 'channel').maxRetransmits;
    }
    get protocol(): string {
      return slotOf(this, 'channel').protocol;
    }
    get negotiated(): boolean {
      return slotOf(this, 'channel').negotiated;
    }
    get id(): Any {
      return slotOf(this, 'channel').id;
    }
    get priority(): string {
      return slotOf(this, 'channel').priority;
    }
    get readyState(): string {
      return slotOf(this, 'channel').readyState;
    }
    get bufferedAmount(): number {
      return slotOf(this, 'channel').bufferedAmount;
    }
    get bufferedAmountLowThreshold(): number {
      return slotOf(this, 'channel').threshold;
    }
    set bufferedAmountLowThreshold(value: Any) {
      const n = Number(value);
      slotOf(this, 'channel').threshold = Number.isFinite(n)
        ? Math.trunc(n) >>> 0
        : 0;
    }
    get binaryType(): string {
      return slotOf(this, 'channel').binaryType;
    }
    set binaryType(value: Any) {
      const type = String(value);
      if (type === 'blob' || type === 'arraybuffer') {
        slotOf(this, 'channel').binaryType = type;
      }
    }
    send(data: Any): void {
      const s = slotOf(this, 'channel');
      if (s.readyState !== 'open') {
        throw domError('The data channel is not open.', 'InvalidStateError');
      }
      let binary = false;
      let payload: string;
      let size: number;
      if (typeof data === 'string') {
        payload = data;
        size = utf8Length(data);
      } else {
        let bytes: Uint8Array;
        if (data instanceof ArrayBuffer) bytes = new U8(data);
        else if (isView(data)) {
          bytes = new U8(data.buffer, data.byteOffset, data.byteLength);
        } else if (Blob && data instanceof Blob && data._bytes) {
          bytes = data._bytes;
        } else {
          payload = String(data);
          size = utf8Length(payload);
          bytes = null as Any;
        }
        if (bytes) {
          binary = true;
          payload = base64OfBytes(bytes);
          size = bytes.byteLength;
        }
      }
      const max = maxMessageOf(s);
      if (size! > max) {
        throw typeError(
          'The message is larger than the transport’s maxMessageSize.',
        );
      }
      // what may wait to be sent, as Chrome has it: past it, a message
      // cannot be queued (WebRTC 1.0, 6.2, send())
      if (s.bufferedAmount + size! > SEND_BUFFER) {
        throw domError(
          'The data channel’s send buffer is full.',
          'OperationError',
        );
      }
      s.bufferedAmount += size!;
      s.transferable = false;
      call('rtcSend', s.host, binary, payload!);
    }
    close(): void {
      const s = slotOf(this, 'channel');
      if (s.readyState === 'closing' || s.readyState === 'closed') return;
      s.readyState = 'closing';
      call('rtcCloseChannel', s.host);
    }
  }
  for (const name of [
    'open',
    'bufferedamountlow',
    'error',
    'closing',
    'close',
    'message',
  ]) {
    handler(RTCDataChannel.prototype, name);
  }

  class RTCDataChannelEvent extends Event {
    constructor(type: string, init: Any) {
      const channel = init?.channel;
      if (!channel || !apply(wmGet, slots, [channel])?.channel) {
        throw typeError(
          "Failed to construct 'RTCDataChannelEvent': required member channel is not an RTCDataChannel.",
        );
      }
      super(type, init);
      apply(wmSet, slots, [this, { channelEvent: true, channel }]);
    }
    get channel(): Any {
      return slotOf(this, 'channelEvent').channel;
    }
  }

  /** The largest message a channel's transport takes. */
  const maxMessageOf = (s: Any): number =>
    stateOf(s.pc).sctp
      ? apply(wmGet, slots, [stateOf(s.pc).sctp]).maxMessageSize
      : (s.maxMessage ?? 65536);

  const make = (pc: Any, host: number, init: Any, readyState: string): Any => {
    const channel = new RTCDataChannel(TOKEN);
    const s = {
      channel: true,
      self: channel,
      pc,
      host,
      label: init.label,
      ordered: init.ordered,
      maxPacketLifeTime: init.maxPacketLifeTime,
      maxRetransmits: init.maxRetransmits,
      protocol: init.protocol,
      negotiated: init.negotiated,
      id: init.id,
      priority: init.priority,
      readyState,
      bufferedAmount: 0,
      threshold: 0,
      binaryType: 'arraybuffer',
      opened: false,
      // a channel may be handed to a worker until the task that made it
      // ends (WebRTC 1.0, 6.2, [[IsTransferable]])
      transferable: true,
      maxMessage: null as number | null,
    };
    apply(wmSet, slots, [channel, s]);
    channels.set(host, s);
    stateOf(pc).channels.add(s);
    D.later(() => {
      s.transferable = false;
    });
    return channel;
  };

  // what becomes of a channel, as the host tells it
  entry('__rtcChannel', () => {
    const [host, kind, value] = input() as [number, string, Any];
    const s = channels.get(host);
    if (!s || s.pc.closed) return null;
    const self = s.self;
    switch (kind) {
      case 'id':
        if (s.id === null) s.id = Number(value);
        break;
      case 'open':
        if (s.opened || s.readyState === 'closing' || s.readyState === 'closed')
          break;
        s.opened = true;
        s.readyState = 'open';
        simple(self, 'open');
        break;
      case 'message':
      case 'binary': {
        if (s.readyState !== 'open') break;
        let data: Any = value;
        if (kind === 'binary') {
          const bytes = bytesOfBase64(String(value));
          data =
            s.binaryType === 'blob' && Blob
              ? new Blob([bytes])
              : bytes.slice().buffer;
        }
        fire(self, new MessageEvent('message', { data }));
        break;
      }
      case 'sent': {
        const before = s.bufferedAmount;
        s.bufferedAmount = Math.max(0, before - Number(value));
        if (before > s.threshold && s.bufferedAmount <= s.threshold) {
          simple(self, 'bufferedamountlow');
        }
        break;
      }
      case 'closing':
        // only a closing the peer started is announced: the page's own
        // `close()` made the channel closing already (WebRTC 1.0, 6.2,
        // "announce closing")
        if (s.readyState === 'closed' || s.readyState === 'closing') break;
        s.readyState = 'closing';
        simple(self, 'closing');
        break;
      case 'closed':
        if (s.readyState === 'closed') break;
        s.readyState = 'closed';
        channels.delete(host);
        simple(self, 'close');
        break;
      case 'error':
        fire(
          self,
          deps.errorEvent(
            {
              errorDetail: value?.errorDetail ?? 'data-channel-failure',
              sctpCauseCode: value?.sctpCauseCode ?? null,
            },
            String(value?.message ?? ''),
          ),
        );
        break;
    }
    return null;
  });

  const PRIORITIES = ['very-low', 'low', 'medium', 'high'];

  const interfaces = { RTCDataChannel, RTCDataChannelEvent, RTCSctpTransport };
  idl(interfaces);
  return {
    interfaces,
    create(pc: Any, label: Any, init: Any) {
      const i =
        init === undefined || init === null
          ? {}
          : typeof init === 'object' || typeof init === 'function'
            ? init
            : (() => {
                throw typeError(
                  "Failed to execute 'createDataChannel': parameter 2 is not of type 'RTCDataChannelInit'.",
                );
              })();
      const name = label === undefined ? '' : String(label);
      if (utf8Length(name) > 65535) {
        throw typeError('The label is longer than 65535 bytes.');
      }
      const protocol = i.protocol === undefined ? '' : String(i.protocol);
      if (utf8Length(protocol) > 65535) {
        throw typeError('The protocol is longer than 65535 bytes.');
      }
      const lifetime =
        i.maxPacketLifeTime === undefined || i.maxPacketLifeTime === null
          ? null
          : enforceShort(i.maxPacketLifeTime, 'maxPacketLifeTime');
      const retransmits =
        i.maxRetransmits === undefined || i.maxRetransmits === null
          ? null
          : enforceShort(i.maxRetransmits, 'maxRetransmits');
      const negotiated = !!i.negotiated;
      // an id is the page's only for a channel it negotiates itself; the
      // stack chooses every other's (WebRTC 1.0, 6.1, createDataChannel)
      const given =
        i.id === undefined || i.id === null ? null : enforceShort(i.id, 'id');
      const id = negotiated ? given : null;
      const priority = i.priority === undefined ? 'low' : String(i.priority);
      if (!PRIORITIES.includes(priority)) {
        throw typeError(
          `The provided value '${priority}' is not a valid enum value of type RTCPriorityType.`,
        );
      }
      if (lifetime !== null && retransmits !== null) {
        throw typeError(
          'maxPacketLifeTime and maxRetransmits cannot both be set.',
        );
      }
      if (negotiated && id === null) {
        throw typeError('A negotiated data channel needs an id.');
      }
      if (id === 65535)
        throw typeError('65535 is not an id a channel can have.');
      const sctp = stateOf(pc).sctp;
      const maxChannels = sctp ? apply(wmGet, slots, [sctp]).maxChannels : null;
      if (id !== null && maxChannels !== null && id >= maxChannels) {
        throw domError(
          'The id is past the transport’s channels.',
          'OperationError',
        );
      }
      for (const other of stateOf(pc).channels) {
        if (id !== null && other.id === id && other.readyState !== 'closed') {
          throw domError(
            `A channel already has the id ${id}.`,
            'OperationError',
          );
        }
      }
      const normal = {
        label: name,
        ordered: i.ordered === undefined ? true : !!i.ordered,
        maxPacketLifeTime: lifetime,
        maxRetransmits: retransmits,
        protocol,
        negotiated,
        id,
        priority,
      };
      const host = Number(call('rtcChannel', pc.id, stringify(normal)));
      return make(pc, host, normal, 'connecting');
    },
    remote(pc: Any, host: number, init: Any) {
      const channel = make(
        pc,
        host,
        {
          label: String(init.label ?? ''),
          ordered: init.ordered !== false,
          maxPacketLifeTime: init.maxPacketLifeTime ?? null,
          maxRetransmits: init.maxRetransmits ?? null,
          protocol: String(init.protocol ?? ''),
          negotiated: !!init.negotiated,
          id: typeof init.id === 'number' ? init.id : null,
          priority: PRIORITIES.includes(init.priority) ? init.priority : 'low',
        },
        'open',
      );
      // a channel the peer opened is open as the page hears of it, and its
      // `open` follows (WebRTC 1.0, 6.2, "announce the data channel")
      fire(pc.self, new RTCDataChannelEvent('datachannel', { channel }));
    },
    sctpNegotiated(pc: Any, sctp: Any, dtls?: Any) {
      const st = stateOf(pc);
      const max = Number(sctp.maxMessageSize);
      if (!st.sctp) {
        st.sctp = new RTCSctpTransport(TOKEN);
        apply(wmSet, slots, [
          st.sctp,
          {
            sctp: true,
            dtls: dtls ?? null,
            state: 'connecting',
            maxMessageSize: max === 0 ? Infinity : max,
            maxChannels: sctp.maxChannels ?? null,
          },
        ]);
      } else {
        const s = apply(wmGet, slots, [st.sctp]);
        s.maxMessageSize = max === 0 ? Infinity : max;
        if (dtls) s.dtls = dtls;
      }
    },
    sctpState(pc: Any, state: Any) {
      const st = stateOf(pc);
      if (!st.sctp) return;
      const s = apply(wmGet, slots, [st.sctp]);
      if (state.maxChannels !== undefined) s.maxChannels = state.maxChannels;
      if (state.state && state.state !== s.state) {
        s.state = state.state;
        simple(st.sctp, 'statechange');
      }
    },
    sctpOf(pc: Any) {
      return stateOf(pc).sctp;
    },
    isChannel(value: Any) {
      const s =
        value && typeof value === 'object'
          ? apply(wmGet, slots, [value])
          : null;
      return !!s?.channel;
    },
    transferable(channel: Any) {
      const s = slotOf(channel, 'channel');
      return s.transferable && s.readyState !== 'closed';
    },
    transferData(channel: Any) {
      const s = slotOf(channel, 'channel');
      return {
        host: s.host,
        state: {
          label: s.label,
          ordered: s.ordered,
          maxPacketLifeTime: s.maxPacketLifeTime,
          maxRetransmits: s.maxRetransmits,
          protocol: s.protocol,
          negotiated: s.negotiated,
          id: s.id,
          priority: s.priority,
          readyState: s.readyState,
          bufferedAmount: s.bufferedAmount,
          threshold: s.threshold,
          binaryType: s.binaryType,
          opened: s.opened,
          maxMessage: maxMessageOf(s),
        },
      };
    },
    transferOut(channel: Any, worker: number) {
      const s = slotOf(channel, 'channel');
      // the host tells the worker of it from here on; this one is closed
      // and hears nothing more (WebRTC 1.0, 6.2, "transfer steps")
      s.transferable = false;
      call('rtcTransfer', s.host, worker);
      channels.delete(s.host);
      s.readyState = 'closed';
    },
    adopt(host: number, state: Any) {
      // a worker has no connection: what a channel reads of one is its own
      const pc = { closed: false, id: -1, self: null };
      const channel = make(
        pc,
        host,
        {
          label: String(state?.label ?? ''),
          ordered: state?.ordered !== false,
          maxPacketLifeTime: state?.maxPacketLifeTime ?? null,
          maxRetransmits: state?.maxRetransmits ?? null,
          protocol: String(state?.protocol ?? ''),
          negotiated: !!state?.negotiated,
          id: typeof state?.id === 'number' ? state.id : null,
          priority: PRIORITIES.includes(state?.priority)
            ? state.priority
            : 'low',
        },
        String(state?.readyState ?? 'connecting'),
      );
      const s = slotOf(channel, 'channel');
      s.bufferedAmount = Number(state?.bufferedAmount) || 0;
      s.threshold = Number(state?.threshold) || 0;
      s.binaryType = state?.binaryType === 'blob' ? 'blob' : 'arraybuffer';
      s.opened = !!state?.opened;
      s.maxMessage =
        typeof state?.maxMessage === 'number' ? state.maxMessage : null;
      call('rtcAdopt', host);
      return channel;
    },
    closeAll(pc: Any) {
      const st = stateOf(pc);
      for (const s of st.channels) {
        s.readyState = 'closed';
        channels.delete(s.host);
      }
      if (st.sctp) apply(wmGet, slots, [st.sctp]).state = 'closed';
    },
  };
}
