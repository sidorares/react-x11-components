// WebRTC 1.0, as a page's scripts see it: `RTCPeerConnection` and what it
// is made of — its transceivers, senders and receivers, its descriptions
// and candidates, its ICE and DTLS transports — over the host's peer
// connections (`peers.ts`, the `rtc…` ops and `__rtc…` entries, over the
// `HtmlScripts.webRTC` seam).
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` calls it with what it reaches
// the host by.
//
// **WebRTC's semantics are this realm's** (docs/prd-webrtc.md): the
// operations chain, the signalling state, every check and the error it
// throws, the order events are told in, and what the specification works
// out from state it has. That is the connection's ICE, connection and
// gathering states, from its transports'; whether negotiation is needed;
// the `track` events a description makes; and a stopped transceiver's
// place. The host answers what no page could compute: an offer, an answer,
// a description applied, the transports' states and their candidates.
// Data channels are `datachannel.ts`'s; candidates, transports and stats
// are `rtc-transports.ts`'s; tracks and streams are `mediastream.ts`'s.

import type { DataChannelsInternals } from './datachannel.js';
import type { EncodedTransformInternals } from './encoded-transform.js';
import type { MediaStreamsInternals } from './mediastream.js';
import type { installRtcTransports } from './rtc-transports.js';

/** What `installDom` hands this. */
export interface WebRTCDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  DOMException: unknown;
  EventTarget: unknown;
  /** Sets a target's `on<type>` handler, which takes its place among
   *  its listeners as it is first set (HTML 8.1.8.1). */
  setHandler(target: unknown, type: string, value: unknown): void;
  Event: unknown;
  /** Dispatches an event the user agent fires. */
  fire(target: unknown, event: unknown): void;
  /** Runs `fn` in a task of its own, after `ms`. */
  setTimer(fn: () => void, ms: number): unknown;
  URL: unknown;
  bytesOfBase64(text: string): Uint8Array;
  media: MediaStreamsInternals;
  /** Makes `datachannel.ts`'s classes, with what they need of a
   *  connection. */
  channels: DataChannelsInternals;
  /** `encoded-transform.ts`'s, which `sender.transform` and
   *  `receiver.transform` take. */
  encoded: EncodedTransformInternals;
  /** Installs `rtc-transports.ts`, which this calls with its own helpers,
   *  so that the two share their slots. */
  transports: typeof installRtcTransports;
  /** Is handed what a message carries an `RTCCertificate` by, which is
   *  `[Serializable]`: whether a value is one, what it crosses as, and one
   *  made again from that. */
  certificates?(internals: {
    is(value: unknown): boolean;
    data(value: unknown): unknown;
    from(data: unknown): unknown;
  }): void;
}

export function installWebRTC(deps: WebRTCDeps): Record<string, unknown> {
  'use strict';
  type Any = any;
  const D: Any = deps;
  /** A description's ICE credentials and DTLS fingerprints, which say
   *  whose transport it is. */
  const credentialsOf = (sdp: string): string =>
    (sdp.match(/^a=(?:ice-ufrag|ice-pwd|fingerprint):.*$/gm) ?? [])
      .map((l: string) => l.trim())
      .sort()
      .join('\n');
  const noteCreated = (s: Any, sdp: string): void => {
    s.created.push(sdp);
    if (s.created.length > 16) s.created.shift();
  };
  const call: Any = D.call;
  const entry: Any = D.entry;
  const input: Any = D.input;
  const DOMException: Any = D.DOMException;
  const EventTarget: Any = D.EventTarget;
  const setHandler: Any = D.setHandler;
  const Event: Any = D.Event;
  const fire: Any = D.fire;
  const setTimer: Any = D.setTimer;
  const URLClass: Any = D.URL;
  const bytesOfBase64: Any = D.bytesOfBase64;
  const media: Any = D.media;
  const channels: Any = D.channels;

  const P: Any = Promise;
  const pThen: Any = P.prototype.then;
  const apply: Any = Reflect.apply;
  const WM: Any = WeakMap;
  const wmGet: Any = WM.prototype.get;
  const wmSet: Any = WM.prototype.set;
  const stringify: Any = JSON.stringify;
  const parse: Any = JSON.parse;
  const freeze: Any = Object.freeze;
  const TOKEN = freeze(Object.create(null));

  const typeError = (message: string): Any => new TypeError(message);
  const rangeError = (message: string): Any => new RangeError(message);
  const domError = (message: string, name: string): Any =>
    new DOMException(message, name);
  const invalidState = (message = 'The RTCPeerConnection is closed.'): Any =>
    domError(message, 'InvalidStateError');
  const illegal = (): Any => typeError('Illegal invocation');
  const illegalConstructor = (): Any => typeError('Illegal constructor');
  const rejected = (e: Any): Promise<Any> => new P((_: Any, r: Any) => r(e));
  const resolved = (v?: Any): Promise<Any> => new P((r: Any) => r(v));
  const then = (p: Any, ok: Any, bad?: Any): Any => apply(pThen, p, [ok, bad]);

  const slots = new WM();
  const slotOf = (self: Any, tag: string): Any => {
    const s =
      self && typeof self === 'object' ? apply(wmGet, slots, [self]) : null;
    if (!s || !s[tag]) throw illegal();
    return s;
  };
  const isA = (v: Any, tag: string): boolean => {
    const s = v && typeof v === 'object' ? apply(wmGet, slots, [v]) : null;
    return !!s?.[tag];
  };
  /** An event handler IDL attribute, its accessors named as Web IDL
   *  names them. */
  const handler = (proto: Any, name: string): void => {
    const get = function (this: Any) {
      return this._handlers[name] ?? null;
    };
    const set = function (this: Any, fn: Any) {
      setHandler(
        this,
        name,
        typeof fn === 'function' || (typeof fn === 'object' && fn) ? fn : null,
      );
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

  /** Web IDL's enum conversion: the string, or a `TypeError`. */
  const enumOf = (
    value: Any,
    allowed: string[],
    what: string,
    fallback?: string,
  ): string => {
    if (value === undefined && fallback !== undefined) return fallback;
    const s = String(value);
    if (!allowed.includes(s)) {
      throw typeError(
        `The provided value '${s}' is not a valid enum value of type ${what}.`,
      );
    }
    return s;
  };
  /** Web IDL's `[EnforceRange] unsigned short`/`octet`. */
  const enforce = (value: Any, max: number, what: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw typeError(`${what} is not a finite number.`);
    }
    const t = Math.trunc(n);
    if (t < 0 || t > max) {
      throw typeError(`${what} is outside the range [0, ${max}].`);
    }
    return t;
  };
  const dictionary = (value: Any, what: string): Any => {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' && typeof value !== 'function') {
      throw typeError(`The provided value is not of type '${what}'.`);
    }
    return value;
  };

  // --- requests of the host's, settled by an entry -------------------------------

  let requestSeq = 0;
  const waiting = new Map<
    number,
    { resolve(v: Any): void; reject(e: Any): void }
  >();
  const ask = (run: (req: number) => void): Promise<Any> =>
    new P((resolve: Any, reject: Any) => {
      const req = ++requestSeq;
      waiting.set(req, { resolve, reject });
      try {
        run(req);
      } catch (error) {
        waiting.delete(req);
        reject(error);
      }
    });

  /** What a host error comes to, of this realm's classes. */
  const errorOf = (e: Any): Any => {
    const name = String(e?.name ?? 'OperationError');
    const message = String(e?.message ?? '');
    if (name === 'RTCError') {
      return new RTCError(
        { errorDetail: 'data-channel-failure', ...(e?.detail ?? {}) },
        message,
      );
    }
    if (name === 'TypeError') return typeError(message);
    if (name === 'RangeError') return rangeError(message);
    return domError(message, name);
  };

  entry('__rtcSettled', () => {
    const [req, ok, payload] = input() as [number, boolean, Any];
    const w = waiting.get(req);
    if (!w) return null;
    waiting.delete(req);
    if (ok) w.resolve(payload);
    else w.reject(errorOf(payload));
    return null;
  });

  // --- errors -------------------------------------------------------------------

  const ERROR_DETAILS = [
    'data-channel-failure',
    'dtls-failure',
    'fingerprint-failure',
    'sctp-failure',
    'sdp-syntax-error',
    'hardware-encoder-not-available',
    'hardware-encoder-error',
  ];

  class RTCError extends DOMException {
    constructor(init: Any, message: Any = undefined) {
      if (init === undefined || init === null || typeof init !== 'object') {
        throw typeError(
          "Failed to construct 'RTCError': parameter 1 is not of type 'RTCErrorInit'.",
        );
      }
      if (init.errorDetail === undefined) {
        throw typeError(
          "Failed to construct 'RTCError': required member errorDetail is undefined.",
        );
      }
      super(message === undefined ? '' : String(message), 'OperationError');
      const opt = (v: Any): Any =>
        v === undefined || v === null ? null : Number(v);
      apply(wmSet, slots, [
        this,
        {
          rtcError: true,
          errorDetail: enumOf(
            init.errorDetail,
            ERROR_DETAILS,
            'RTCErrorDetailType',
          ),
          sdpLineNumber: opt(init.sdpLineNumber),
          sctpCauseCode: opt(init.sctpCauseCode),
          receivedAlert: opt(init.receivedAlert),
          sentAlert: opt(init.sentAlert),
        },
      ]);
    }
    get errorDetail(): string {
      return slotOf(this, 'rtcError').errorDetail;
    }
    get sdpLineNumber(): Any {
      return slotOf(this, 'rtcError').sdpLineNumber;
    }
    get sctpCauseCode(): Any {
      return slotOf(this, 'rtcError').sctpCauseCode;
    }
    get receivedAlert(): Any {
      return slotOf(this, 'rtcError').receivedAlert;
    }
    get sentAlert(): Any {
      return slotOf(this, 'rtcError').sentAlert;
    }
  }

  class RTCErrorEvent extends Event {
    constructor(type: string, init: Any) {
      if (!init || !(init.error instanceof RTCError)) {
        throw typeError(
          "Failed to construct 'RTCErrorEvent': required member error is not an RTCError.",
        );
      }
      super(type, init);
      apply(wmSet, slots, [this, { errorEvent: true, error: init.error }]);
    }
    get error(): Any {
      return slotOf(this, 'errorEvent').error;
    }
  }

  // --- descriptions -------------------------------------------------------------

  const SDP_TYPES = ['offer', 'pranswer', 'answer', 'rollback'];

  class RTCSessionDescription {
    constructor(init: Any) {
      if (init === undefined || init === null || typeof init !== 'object') {
        throw typeError(
          "Failed to construct 'RTCSessionDescription': parameter 1 is not of type 'RTCSessionDescriptionInit'.",
        );
      }
      if (init.type === undefined) {
        throw typeError(
          "Failed to construct 'RTCSessionDescription': required member type is undefined.",
        );
      }
      const type = enumOf(init.type, SDP_TYPES, 'RTCSdpType');
      const sdp = init.sdp === undefined ? '' : String(init.sdp);
      apply(wmSet, slots, [this, { description: true, type, sdp }]);
    }
    get type(): string {
      return slotOf(this, 'description').type;
    }
    get sdp(): string {
      return slotOf(this, 'description').sdp;
    }
    toJSON(): Any {
      const s = slotOf(this, 'description');
      return { type: s.type, sdp: s.sdp };
    }
  }

  // --- candidates, transports and stats: `rtc-transports.ts`'s --------------

  const transports: Any = D.transports({
    slots,
    slotOf,
    apply,
    wmGet,
    wmSet,
    TOKEN,
    illegalConstructor,
    handler,
    typeError,
    enforce,
    dictionary,
    simple,
    fire,
    Event,
    EventTarget,
    setTimer,
    entry,
    input,
    call,
    bytesOfBase64,
    stringify,
    rejected,
    then,
    invalidState,
    ask,
    channels,
    connectionOf: (id: number) => connections.get(id),
    sectionOfTransport: (s: Any, id: number) => sectionOfTransport(s, id),
    transportsInUse: (s: Any) => transportsInUse(s),
    remoteText: (s: Any) => {
      const d = descriptionsOf(s);
      return `${d.currentRemote ?? ''}\n${d.pendingRemote ?? ''}`;
    },
  });
  const {
    parseCandidate,
    iceInitOf,
    RTCIceCandidate,
    RTCPeerConnectionIceEvent,
    RTCPeerConnectionIceErrorEvent,
    RTCIceCandidatePair,
    RTCIceTransport,
    RTCDtlsTransport,
    transportOf,
    setTransportState,
    RTCStatsReport,
    statsOf,
    updateStates,
    surfacedOnly,
  } = transports;

  // --- SDP, read as far as the specification's checks need -----------------------

  interface SdpSection {
    mid: string | null;
    kind: string;
    port: number;
    direction: string;
    /** The streams its `msid` lines name. */
    streams: string[];
    /** Whether it has an `msid`, at the media level or a source's: where
     *  it has none, its track is in a default stream (RFC 8829, 5.10). */
    msid: boolean;
    /** The streams its sources' `msid`s name, which stand in where it has
     *  no media-level one. */
    ssrcStreams: string[];
    ufrag: string | null;
    /** The rids its `a=simulcast` receives, the first of each choice and
     *  none paused left out, or null where it has none. */
    simulcastRecv: string[] | null;
  }

  const sectionsOf = (sdp: string | null): SdpSection[] => {
    const out: SdpSection[] = [];
    if (!sdp) return out;
    let session = 'sendrecv';
    let sessionUfrag: string | null = null;
    let current: SdpSection | null = null;
    for (const raw of sdp.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('m=')) {
        const parts = line.slice(2).split(' ');
        current = {
          mid: null,
          kind: parts[0],
          port: Number(parts[1]),
          direction: session,
          streams: [],
          msid: false,
          ssrcStreams: [],
          ufrag: sessionUfrag,
          simulcastRecv: null,
        };
        out.push(current);
        continue;
      }
      if (!line.startsWith('a=')) continue;
      const attr = line.slice(2);
      const colon = attr.indexOf(':');
      const name = colon < 0 ? attr : attr.slice(0, colon);
      const value = colon < 0 ? '' : attr.slice(colon + 1);
      if (
        name === 'sendrecv' ||
        name === 'sendonly' ||
        name === 'recvonly' ||
        name === 'inactive'
      ) {
        if (current) current.direction = name;
        else session = name;
      } else if (name === 'ice-ufrag') {
        if (current) current.ufrag = value;
        else sessionUfrag = value;
      } else if (current && name === 'mid') current.mid = value;
      else if (current && name === 'simulcast') {
        // `a=simulcast:send 1;2 recv 3,4;~5` (RFC 8853): a direction and
        // its streams, in pairs, a stream's choices after commas
        const tokens = value.trim().split(/\s+/);
        for (let i = 0; i + 1 < tokens.length; i += 2) {
          if (tokens[i] !== 'recv') continue;
          // a rid named twice is one stream (w3c/webrtc-pc#2780), and a
          // paused one, `~`, is a stream all the same: it says nothing of
          // the sender's `active`
          current.simulcastRecv = tokens[i + 1]
            .split(';')
            .map((alt) => alt.split(',')[0].replace(/^~/, ''))
            .filter((rid, j, all) => rid !== '' && all.indexOf(rid) === j);
        }
      } else if (current && name === 'msid') {
        current.msid = true;
        const stream = value.split(' ')[0];
        if (stream && stream !== '-' && !current.streams.includes(stream)) {
          current.streams.push(stream);
        }
      } else if (current && name === 'ssrc') {
        // `a=ssrc:3 msid:1 2`, a source's own, as Plan B wrote it
        const m = /^\d+ msid:(\S+)/.exec(value);
        if (m) {
          current.msid = true;
          if (m[1] !== '-' && !current.ssrcStreams.includes(m[1])) {
            current.ssrcStreams.push(m[1]);
          }
        }
      }
    }
    return out;
  };

  const reversed = (d: string): string =>
    d === 'sendonly' ? 'recvonly' : d === 'recvonly' ? 'sendonly' : d;
  const sends = (d: string | null): boolean =>
    d === 'sendrecv' || d === 'sendonly';
  const receives = (d: string | null): boolean =>
    d === 'sendrecv' || d === 'recvonly';
  const directionOf = (send: boolean, recv: boolean): string =>
    send && recv
      ? 'sendrecv'
      : send
        ? 'sendonly'
        : recv
          ? 'recvonly'
          : 'inactive';

  // --- tracks of a connection ---------------------------------------------------

  /** A connection's remote stream by its id: one object for its life. */
  const streamOf = (s: Any, id: string): Any => {
    let stream = s.streams.get(id);
    if (!stream) {
      stream = media.stream(id);
      s.streams.set(id, stream);
    }
    return stream;
  };

  // --- senders, receivers, transceivers ------------------------------------------

  const DIRECTIONS = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];
  /** The header extensions a transceiver lists as `stopped` until a page
   *  asks for them, as Chrome does: `rtc-codecs.ts`'s `stoppedByDefault`. */
  const STOPPED_BY_DEFAULT = [
    'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time',
  ];
  /** What a transceiver negotiates both ways whatever a page says. */
  const MANDATORY_EXTENSIONS = ['urn:ietf:params:rtp-hdrext:sdes:mid'];
  const PRIORITIES = ['very-low', 'low', 'medium', 'high'];

  const capabilitiesOf = (kind: string, side: string): Any => {
    // a kind that is neither has no capabilities (WebRTC 1.0, 5.2)
    if (kind !== 'audio' && kind !== 'video') return null;
    const text = call('rtcCapabilities', kind, side);
    return typeof text === 'string' ? parse(text) : null;
  };

  const sameCodec = (a: Any, b: Any): boolean =>
    String(a.mimeType).toLowerCase() === String(b.mimeType).toLowerCase() &&
    Number(a.clockRate) === Number(b.clockRate) &&
    (a.channels ?? 1) === (b.channels ?? 1) &&
    (a.sdpFmtpLine ?? '') === (b.sdpFmtpLine ?? '');

  /** An encoding's `scaleResolutionDownTo` (WebRTC Extensions,
   *  `RTCResolutionRestriction`), its two sizes `unsigned long`s, or what
   *  says it is wrong: a size of 0, which no frame fits. */
  const restrictionOf = (value: Any): Any => {
    if (value === undefined || value === null) return undefined;
    const r = dictionary(value, 'RTCResolutionRestriction');
    const size = (v: Any): number => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) >>> 0 : 0;
    };
    const out = { maxWidth: size(r.maxWidth), maxHeight: size(r.maxHeight) };
    return out.maxWidth > 0 && out.maxHeight > 0 ? out : null;
  };
  /** Whether a sender's encodings restrict their sizes as one: each
   *  active one, or none (WebRTC Extensions, `scaleResolutionDownTo`). */
  const restrictedAlike = (list: Any[]): boolean => {
    const active = list.filter((e: Any) => e.active !== false);
    const some = active.filter((e: Any) => e.scaleResolutionDownTo);
    return some.length === 0 || some.length === active.length;
  };

  /** The most encodings a sender sends at once, as Chrome's simulcast has
   *  them. */
  const MAX_ENCODINGS = 4;
  /** The `sendEncodings` a transceiver is made with, checked and given
   *  their defaults as `addTransceiver` gives them. */
  const encodingsOf = (list: Any, kind: string): Any[] => {
    if (list === undefined) list = [];
    if (!list || typeof list[Symbol.iterator] !== 'function') {
      throw typeError(
        "Failed to execute 'addTransceiver': sendEncodings is not a sequence.",
      );
    }
    const given = [...list].map((e: Any) =>
      dictionary(e, 'RTCRtpEncodingParameters'),
    );
    const rids = given
      .filter((e: Any) => e.rid !== undefined)
      .map((e: Any) => String(e.rid));
    for (const rid of rids) {
      // letters and digits, at most 16 (WebRTC 1.0, addTransceiver), where
      // RFC 8851's grammar takes `-` and `_` as well
      if (!/^[A-Za-z0-9]{1,16}$/.test(rid)) {
        throw typeError(`Invalid rid '${rid}'.`);
      }
    }
    // some with a rid and some without is no simulcast anyone can name;
    // none with one is a sender's encodings all the same (WebRTC 1.0,
    // addTransceiver)
    if (rids.length && rids.length !== given.length) {
      throw typeError('Every encoding of a simulcast sender needs a rid.');
    }
    if (new Set(rids).size !== rids.length) {
      throw typeError('Two encodings have one rid.');
    }
    const caps = capabilitiesOf(kind, 'sender');
    const out: Any[] = [];
    // audio sends one encoding, and what only video has is dropped
    if (kind === 'audio') given.splice(1);
    // what is past the most a sender sends at once is trimmed from the tail,
    // once every encoding is checked (WebRTC 1.0, addTransceiver)
    const kept = Math.min(given.length, MAX_ENCODINGS);
    given.forEach((e: Any, i: number) => {
      if (
        kind === 'video' &&
        e.scaleResolutionDownBy !== undefined &&
        Number(e.scaleResolutionDownBy) < 1
      ) {
        throw rangeError('scaleResolutionDownBy must be at least 1.');
      }
      if (
        kind === 'video' &&
        e.maxFramerate !== undefined &&
        Number(e.maxFramerate) < 0
      ) {
        throw rangeError('maxFramerate must not be negative.');
      }
      if (
        e.codec !== undefined &&
        !(caps?.codecs ?? []).some((c: Any) => sameCodec(c, e.codec))
      ) {
        throw domError(
          'The codec is not one this sender can send.',
          'OperationError',
        );
      }
      const enc: Any = {
        active: e.active === undefined ? true : !!e.active,
        priority: enumOf(e.priority, PRIORITIES, 'RTCPriorityType', 'low'),
        networkPriority: enumOf(
          e.networkPriority,
          PRIORITIES,
          'RTCPriorityType',
          'low',
        ),
      };
      // a single encoding is no simulcast, and keeps no rid
      if (e.rid !== undefined && given.length > 1) enc.rid = String(e.rid);
      if (e.maxBitrate !== undefined) enc.maxBitrate = Number(e.maxBitrate);
      if (e.scalabilityMode !== undefined)
        enc.scalabilityMode = String(e.scalabilityMode);
      if (e.codec !== undefined) enc.codec = { ...e.codec };
      if (kind === 'video') {
        const to = restrictionOf(e.scaleResolutionDownTo);
        if (to === null) {
          throw domError(
            'scaleResolutionDownTo needs a width and a height above 0.',
            'OperationError',
          );
        }
        if (to) enc.scaleResolutionDownTo = to;
        if (e.maxFramerate !== undefined)
          enc.maxFramerate = Number(e.maxFramerate);
        enc.scaleResolutionDownBy =
          e.scaleResolutionDownBy !== undefined
            ? Number(e.scaleResolutionDownBy)
            : given
                  .slice(0, kept)
                  .some((x: Any) => x.scaleResolutionDownBy !== undefined)
              ? 1
              : 2 ** Math.max(0, kept - i - 1);
      }
      out.push(enc);
    });
    if (!restrictedAlike(out)) {
      throw domError(
        'scaleResolutionDownTo is set on some active encodings and not on others.',
        'OperationError',
      );
    }
    out.splice(kept);
    if (!out.length) {
      out.push(
        kind === 'video'
          ? {
              active: true,
              priority: 'low',
              networkPriority: 'low',
              scaleResolutionDownBy: 1,
            }
          : { active: true, priority: 'low', networkPriority: 'low' },
      );
    }
    return out;
  };

  const NO_PARAMETERS = (): Any => ({
    codecs: [],
    headerExtensions: [],
    rtcp: { cname: '', reducedSize: false },
  });

  let transactionSeq = 0;

  /**
   * `sender.transform` and `receiver.transform` set (WebRTC Encoded
   * Transform, 4.4 and 4.5): an `RTCRtpScriptTransform` or null, one in use
   * by another sender or receiver an `InvalidStateError`, and the one it
   * replaces let go. The host puts its frames on the new one's worker.
   */
  const setTransform = (
    owner: Any,
    s: Any,
    side: 'sender' | 'receiver',
    value: Any,
  ): void => {
    const encoded: Any = D.encoded;
    if (value !== null && !encoded.isTransform(value)) {
      throw typeError(
        `Failed to set the 'transform' property on 'RTCRtp${side === 'sender' ? 'Sender' : 'Receiver'}': The provided value is not of type 'RTCRtpScriptTransform'.`,
      );
    }
    const old = s.transform ?? null;
    if (value === old) return;
    if (value !== null) encoded.attach(value, owner, s.tx.id, side);
    s.transform = value;
    if (value === null) call('rtcTransform', s.tx.id, side, 0, 0);
  };

  class RTCRtpSender {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
    }
    get track(): Any {
      return slotOf(this, 'sender').track;
    }
    get transport(): Any {
      const s = slotOf(this, 'sender');
      return s.tx.transport === null || s.tx.stopped
        ? null
        : transportOf(s.tx.pc, s.tx.transport).dtls;
    }
    get dtmf(): Any {
      return slotOf(this, 'sender').dtmf;
    }
    get transform(): Any {
      return slotOf(this, 'sender').transform ?? null;
    }
    set transform(value: Any) {
      setTransform(this, slotOf(this, 'sender'), 'sender', value);
    }
    static getCapabilities(kind: Any): Any {
      return capabilitiesOf(String(kind), 'sender');
    }
    getParameters(): Any {
      const s = slotOf(this, 'sender');
      const p = s.parameters ?? NO_PARAMETERS();
      const out = {
        transactionId: String(++transactionSeq),
        encodings: s.encodings.map((e: Any) =>
          e.scaleResolutionDownTo
            ? { ...e, scaleResolutionDownTo: { ...e.scaleResolutionDownTo } }
            : { ...e },
        ),
        headerExtensions: p.headerExtensions.map((e: Any) => ({ ...e })),
        rtcp: { ...p.rtcp },
        codecs: p.codecs.map((c: Any) => ({ ...c })),
      };
      s.lastReturned = parse(stringify(out));
      // what a later `setParameters` is checked against lasts this task
      setTimer(() => {
        s.lastReturned = null;
      }, 0);
      return out;
    }
    setParameters(parameters: Any, options?: Any): Promise<void> {
      let s: Any;
      try {
        s = slotOf(this, 'sender');
      } catch (error) {
        return rejected(error);
      }
      const pc = s.tx.pc;
      if (pc.closed || s.tx.stopping) return rejected(invalidState());
      const last = s.lastReturned;
      if (!last) {
        return rejected(
          invalidState(
            'getParameters() must be called before setParameters().',
          ),
        );
      }
      const p = parameters ?? {};
      if (p.transactionId === undefined || p.encodings === undefined) {
        return rejected(
          typeError(
            "Failed to execute 'setParameters': required member transactionId or encodings is undefined.",
          ),
        );
      }
      if (String(p.transactionId) !== last.transactionId) {
        return rejected(
          domError(
            'The transactionId is not the last one.',
            'InvalidModificationError',
          ),
        );
      }
      const encodings = [...(p.encodings ?? [])];
      if (
        encodings.length !== last.encodings.length ||
        encodings.some(
          (e: Any, i: number) =>
            (e?.rid ?? undefined) !== last.encodings[i].rid,
        )
      ) {
        return rejected(
          domError(
            'The encodings cannot be added, removed or renamed.',
            'InvalidModificationError',
          ),
        );
      }
      const same = (a: Any, b: Any): boolean =>
        stringify(a ?? null) === stringify(b ?? null);
      if (
        !same(p.rtcp, last.rtcp) ||
        !same(p.headerExtensions, last.headerExtensions) ||
        !same(p.codecs, last.codecs)
      ) {
        return rejected(
          domError(
            'Only the encodings can be changed.',
            'InvalidModificationError',
          ),
        );
      }
      const video = s.tx.kind === 'video';
      // what a codec may be: one negotiated, or before that one the
      // preferences or the capabilities allow
      const negotiated = (s.parameters ?? NO_PARAMETERS()).codecs;
      const allowed = negotiated.length
        ? negotiated
        : s.tx.codecPreferences.length
          ? s.tx.codecPreferences
          : (capabilitiesOf(s.tx.kind, 'sender')?.codecs ?? []);
      for (const e of encodings) {
        if (
          video &&
          e.scaleResolutionDownBy !== undefined &&
          Number(e.scaleResolutionDownBy) < 1
        ) {
          return rejected(
            rangeError('scaleResolutionDownBy must be at least 1.'),
          );
        }
        if (
          video &&
          e.maxFramerate !== undefined &&
          Number(e.maxFramerate) < 0
        ) {
          return rejected(rangeError('maxFramerate must not be negative.'));
        }
        if (
          e.codec !== undefined &&
          !allowed.some((c: Any) => sameCodec(c, e.codec))
        ) {
          return rejected(
            domError(
              'The codec is not one this sender may send.',
              'InvalidModificationError',
            ),
          );
        }
      }
      if (video) {
        // a restriction no frame fits, or one on some active encodings and
        // not on others (WebRTC Extensions, `scaleResolutionDownTo`)
        const restricted = encodings.map((e: Any) => ({
          active: e?.active,
          scaleResolutionDownTo: restrictionOf(e?.scaleResolutionDownTo),
        }));
        if (
          restricted.some((e: Any) => e.scaleResolutionDownTo === null) ||
          !restrictedAlike(restricted)
        ) {
          return rejected(
            domError(
              'scaleResolutionDownTo is not one every active encoding can take.',
              'InvalidModificationError',
            ),
          );
        }
      }
      // `encodingOptions`, one an encoding or none, asks a key frame of
      // each encoding it says so of (WebRTC Extensions, setParameters);
      // audio's are not read
      let keyFrames: boolean[] = [];
      if (video) {
        let given: Any[] = [];
        try {
          given = [
            ...(dictionary(options, 'RTCSetParameterOptions').encodingOptions ??
              []),
          ];
        } catch (error) {
          return rejected(error);
        }
        if (given.length && given.length !== encodings.length) {
          return rejected(
            domError(
              'encodingOptions has one entry an encoding, or none.',
              'InvalidModificationError',
            ),
          );
        }
        keyFrames = given.map((o: Any) => !!o?.keyFrame);
      }
      s.lastReturned = null;
      const next = encodings.map((e: Any) => {
        const enc: Any = {
          active: e.active === undefined ? true : !!e.active,
          priority: PRIORITIES.includes(e.priority) ? e.priority : 'low',
          networkPriority: PRIORITIES.includes(e.networkPriority)
            ? e.networkPriority
            : 'low',
        };
        if (e.rid !== undefined) enc.rid = String(e.rid);
        if (e.maxBitrate !== undefined) enc.maxBitrate = Number(e.maxBitrate);
        if (e.scalabilityMode !== undefined) {
          enc.scalabilityMode = String(e.scalabilityMode);
        }
        if (e.codec !== undefined) enc.codec = { ...e.codec };
        if (video) {
          const to = restrictionOf(e.scaleResolutionDownTo);
          if (to) enc.scaleResolutionDownTo = to;
          if (e.maxFramerate !== undefined) {
            enc.maxFramerate = Number(e.maxFramerate);
          }
          enc.scaleResolutionDownBy =
            e.scaleResolutionDownBy === undefined
              ? 1
              : Number(e.scaleResolutionDownBy);
        }
        return enc;
      });
      return then(
        ask((req) =>
          call(
            'rtcParameters',
            s.tx.id,
            req,
            stringify({ encodings: next, keyFrames }),
          ),
        ),
        () => {
          // what a negotiation took away while it was applied stays away,
          // the rest as the page set it (WebRTC 1.0, 5.2, setParameters)
          const now = s.encodings;
          s.encodings =
            now.length < next.length
              ? next.filter((e: Any) => now.some((n: Any) => n.rid === e.rid))
              : next;
          // and where it took them all, as a rollback to one encoding
          // with no rid does, what it left stands
          if (!s.encodings.length) s.encodings = now;
          s.toldEncodings = stringify(next);
          tellEncodings(s.tx);
        },
      );
    }
    replaceTrack(withTrack: Any): Promise<void> {
      let s: Any;
      try {
        s = slotOf(this, 'sender');
      } catch (error) {
        return rejected(error);
      }
      if (withTrack !== null && !media.isTrack(withTrack)) {
        return rejected(
          typeError(
            "Failed to execute 'replaceTrack': parameter 1 is not of type 'MediaStreamTrack'.",
          ),
        );
      }
      if (withTrack !== null && withTrack.kind !== s.tx.kind) {
        return rejected(typeError('The track is not of the sender’s kind.'));
      }
      return chain(s.tx.pc, () => {
        if (s.tx.stopping)
          return rejected(invalidState('The transceiver is stopped.'));
        sendTrack(s.tx, withTrack);
        // the track is replaced in parallel, and `track` set in a task
        // queued after, which nothing sees before (WebRTC 1.0, 5.2): the
        // chain holds the operation until then
        return new P((r: Any) =>
          setTimer(() => {
            if (!s.tx.pc.closed) s.track = withTrack;
            r(undefined);
          }, 0),
        );
      });
    }
    setStreams(...streams: Any[]): void {
      const s = slotOf(this, 'sender');
      if (s.tx.pc.closed) throw invalidState();
      for (const stream of streams) {
        if (!media.isStream(stream)) {
          throw typeError(
            "Failed to execute 'setStreams': parameter is not of type 'MediaStream'.",
          );
        }
      }
      const ids: string[] = [];
      for (const stream of streams)
        if (!ids.includes(stream.id)) ids.push(stream.id);
      s.streams = ids;
      call('rtcStreams', s.tx.id, stringify(ids));
      updateNegotiationNeeded(s.tx.pc);
    }
    getStats(): Promise<Any> {
      let s: Any;
      try {
        s = slotOf(this, 'sender');
      } catch (error) {
        return rejected(error);
      }
      return statsOf(s.tx.pc, s.tx, 'sender');
    }
  }

  // --- DTMF (WebRTC 1.0, 7) ------------------------------------------------------------

  /** What a tone may be, after `a` to `d` are made upper case. */
  const TONES = '0123456789ABCD#*,';
  /** Web IDL's `unsigned long`, with no `[EnforceRange]`. */
  const unsignedLong = (value: Any): number => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) >>> 0 : 0;
  };
  /** "Determine if DTMF can be sent" (7.2): an audio sender of a connected
   *  connection, with a track, negotiated to send, its first encoding
   *  active and `telephone-event` among what it sends. */
  const canSendTones = (d: Any): boolean => {
    const sender = apply(wmGet, slots, [d.sender]);
    const tx = sender.tx;
    if (tx.pc.closed || tx.pc.connState !== 'connected') return false;
    if (tx.stopping || !sender.track) return false;
    if (
      tx.currentDirection !== 'sendrecv' &&
      tx.currentDirection !== 'sendonly'
    )
      return false;
    if (sender.encodings[0]?.active === false) return false;
    return (sender.parameters?.codecs ?? []).some(
      (c: Any) => String(c.mimeType).toLowerCase() === 'audio/telephone-event',
    );
  };
  /** The DTMF playout task steps: a tone played, and the next queued for
   *  when it and the gap after it are over, or two seconds on for a `,`. */
  const playTones = (d: Any): void => {
    d.queued = false;
    if (!canSendTones(d)) return;
    const self = d.self;
    if (d.buffer === '') {
      fire(self, new RTCDTMFToneChangeEvent('tonechange', { tone: '' }));
      return;
    }
    const tone = d.buffer[0];
    d.buffer = d.buffer.slice(1);
    d.queued = true;
    if (tone === ',') {
      setTimer(() => playTones(d), 2000);
    } else {
      // the seam sends RFC 4733's events where `telephone-event` was
      // negotiated, and the timing is this realm's whatever it says
      const tx = apply(wmGet, slots, [d.sender]).tx;
      call('rtcTone', tx.id, tone, d.duration);
      setTimer(() => playTones(d), d.duration + d.gap);
    }
    fire(self, new RTCDTMFToneChangeEvent('tonechange', { tone }));
  };

  class RTCDTMFSender extends EventTarget {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
      super();
    }
    get canInsertDTMF(): boolean {
      return canSendTones(slotOf(this, 'dtmf'));
    }
    get toneBuffer(): string {
      return slotOf(this, 'dtmf').buffer;
    }
    insertDTMF(tones: Any, duration: Any = 100, interToneGap: Any = 70): void {
      const d = slotOf(this, 'dtmf');
      if (arguments.length < 1) {
        throw typeError(
          "Failed to execute 'insertDTMF' on 'RTCDTMFSender': 1 argument required, but only 0 present.",
        );
      }
      const text = String(tones);
      const ms = duration === undefined ? 100 : unsignedLong(duration);
      const gap = interToneGap === undefined ? 70 : unsignedLong(interToneGap);
      if (!canSendTones(d)) {
        throw invalidState('The RTCDTMFSender cannot send tones.');
      }
      const upper = text.replace(/[a-d]/g, (c) => c.toUpperCase());
      for (const c of upper) {
        if (!TONES.includes(c)) {
          throw domError(
            `The tones contain an unrecognized character '${c}'.`,
            'InvalidCharacterError',
          );
        }
      }
      d.buffer = upper;
      d.duration = Math.min(6000, Math.max(40, ms));
      d.gap = Math.min(6000, Math.max(30, gap));
      if (upper === '' || d.queued) return;
      d.queued = true;
      setTimer(() => playTones(d), 0);
    }
  }
  handler(RTCDTMFSender.prototype, 'tonechange');

  /** An audio sender's `[[Dtmf]]`, made with it. */
  const makeDtmf = (sender: Any): Any => {
    const dtmf = new RTCDTMFSender(TOKEN);
    apply(wmSet, slots, [
      dtmf,
      {
        dtmf: true,
        self: dtmf,
        sender,
        buffer: '',
        duration: 100,
        gap: 70,
        queued: false,
      },
    ]);
    return dtmf;
  };

  class RTCRtpReceiver {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
    }
    get track(): Any {
      return slotOf(this, 'receiver').track;
    }
    get transport(): Any {
      const s = slotOf(this, 'receiver');
      return s.tx.transport === null || s.tx.stopped
        ? null
        : transportOf(s.tx.pc, s.tx.transport).dtls;
    }
    get transform(): Any {
      return slotOf(this, 'receiver').transform ?? null;
    }
    set transform(value: Any) {
      setTransform(this, slotOf(this, 'receiver'), 'receiver', value);
    }
    get jitterBufferTarget(): Any {
      return slotOf(this, 'receiver').jitterBufferTarget;
    }
    set jitterBufferTarget(value: Any) {
      const s = slotOf(this, 'receiver');
      if (value === null) {
        s.jitterBufferTarget = null;
      } else {
        const n = Number(value);
        if (!Number.isFinite(n))
          throw typeError('jitterBufferTarget is not a finite number.');
        if (n < 0 || n > 4000)
          throw rangeError('jitterBufferTarget must be from 0 to 4000.');
        s.jitterBufferTarget = n;
      }
      call('rtcJitter', s.tx.id, s.jitterBufferTarget);
    }
    static getCapabilities(kind: Any): Any {
      return capabilitiesOf(String(kind), 'receiver');
    }
    getParameters(): Any {
      const p = slotOf(this, 'receiver').parameters ?? NO_PARAMETERS();
      // a receiver's RTCP parameters name no cname (WebRTC 1.0, 5.3)
      return {
        headerExtensions: p.headerExtensions.map((e: Any) => ({ ...e })),
        rtcp: { reducedSize: !!p.rtcp?.reducedSize },
        codecs: p.codecs.map((c: Any) => ({ ...c })),
      };
    }
    getContributingSources(): Any[] {
      return sourcesOf(this, 'contributing');
    }
    getSynchronizationSources(): Any[] {
      return sourcesOf(this, 'synchronization');
    }
    getStats(): Promise<Any> {
      let s: Any;
      try {
        s = slotOf(this, 'receiver');
      } catch (error) {
        return rejected(error);
      }
      return statsOf(s.tx.pc, s.tx, 'receiver');
    }
  }

  const sourcesOf = (receiver: Any, kind: string): Any[] => {
    const s = slotOf(receiver, 'receiver');
    const text = call('rtcSources', s.tx.id);
    const list = typeof text === 'string' ? parse(text) : [];
    return list
      .filter((x: Any) => x.kind === kind)
      .map((x: Any) => {
        const out: Any = {
          timestamp: x.timestamp,
          source: x.source,
          rtpTimestamp: x.rtpTimestamp,
        };
        if (x.audioLevel !== undefined) out.audioLevel = x.audioLevel;
        if (x.captureTimestamp !== undefined)
          out.captureTimestamp = x.captureTimestamp;
        if (x.senderCaptureTimeOffset !== undefined)
          out.senderCaptureTimeOffset = x.senderCaptureTimeOffset;
        return out;
      });
  };

  class RTCRtpTransceiver {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
    }
    get mid(): Any {
      return slotOf(this, 'transceiver').mid;
    }
    get sender(): Any {
      return slotOf(this, 'transceiver').sender;
    }
    get receiver(): Any {
      return slotOf(this, 'transceiver').receiver;
    }
    get direction(): string {
      return slotOf(this, 'transceiver').direction;
    }
    set direction(value: Any) {
      const s = slotOf(this, 'transceiver');
      const direction = enumOf(
        value,
        [...DIRECTIONS, 'stopped'],
        'RTCRtpTransceiverDirection',
      );
      if (s.pc.closed) throw invalidState();
      if (s.stopping) throw invalidState('The transceiver is stopped.');
      if (direction === 'stopped') {
        throw typeError(
          "'stopped' is not a direction a transceiver can be given.",
        );
      }
      if (direction === s.direction) return;
      s.direction = direction;
      call('rtcDirection', s.id, direction);
      updateNegotiationNeeded(s.pc);
    }
    get currentDirection(): Any {
      return slotOf(this, 'transceiver').currentDirection;
    }
    /** Whether a negotiation took it out. WebRTC 1.0 has `stopping` and
     *  `currentDirection` where this was, but every browser still has it,
     *  and pages read it. */
    get stopped(): boolean {
      return slotOf(this, 'transceiver').stopped;
    }
    stop(): void {
      const s = slotOf(this, 'transceiver');
      if (s.pc.closed) throw invalidState();
      if (s.stopping) return;
      stopTransceiver(s, false);
      call('rtcStopTransceiver', s.id);
      updateNegotiationNeeded(s.pc);
    }
    setCodecPreferences(codecs: Any): void {
      const s = slotOf(this, 'transceiver');
      if (!codecs || typeof codecs[Symbol.iterator] !== 'function') {
        throw typeError(
          "Failed to execute 'setCodecPreferences': parameter 1 is not a sequence.",
        );
      }
      const list = [...codecs].map((c: Any) => dictionary(c, 'RTCRtpCodec'));
      if (list.length) {
        const caps = capabilitiesOf(s.kind, 'receiver')?.codecs ?? [];
        for (const c of list) {
          if (c.mimeType === undefined || c.clockRate === undefined) {
            throw typeError('A codec needs its mimeType and its clockRate.');
          }
          if (!caps.some((x: Any) => sameCodec(x, c))) {
            throw domError(
              `${c.mimeType} is not a codec this transceiver can receive.`,
              'InvalidModificationError',
            );
          }
        }
        const kinds = list.map(
          (c: Any) => String(c.mimeType).toLowerCase().split('/')[1],
        );
        if (
          kinds.every((k: string) =>
            [
              'rtx',
              'red',
              'ulpfec',
              'flexfec-03',
              'cn',
              'telephone-event',
            ].includes(k),
          )
        ) {
          throw domError(
            'The codecs are all resilience or comfort codecs.',
            'InvalidModificationError',
          );
        }
      }
      s.codecPreferences = list.map((c: Any) => {
        const out: Any = {
          mimeType: String(c.mimeType),
          clockRate: Number(c.clockRate),
        };
        if (c.channels !== undefined) out.channels = Number(c.channels);
        if (c.sdpFmtpLine !== undefined)
          out.sdpFmtpLine = String(c.sdpFmtpLine);
        return out;
      });
      call('rtcCodecs', s.id, stringify(s.codecPreferences));
    }
    getHeaderExtensionsToNegotiate(): Any[] {
      const s = slotOf(this, 'transceiver');
      return s.extensionsToNegotiate.map((e: Any) => ({ ...e }));
    }
    setHeaderExtensionsToNegotiate(extensions: Any): void {
      const s = slotOf(this, 'transceiver');
      if (!extensions || typeof extensions[Symbol.iterator] !== 'function') {
        throw typeError(
          "Failed to execute 'setHeaderExtensionsToNegotiate': parameter 1 is not a sequence.",
        );
      }
      const list = [...extensions].map((e: Any) => {
        // both members are required: an empty URI is none (webrtc-extensions,
        // RTCRtpHeaderExtensionCapability)
        const uri = e?.uri === undefined ? '' : String(e.uri);
        if (uri === '') {
          throw typeError(
            "Failed to execute 'setHeaderExtensionsToNegotiate': an extension has no uri.",
          );
        }
        return {
          uri,
          direction: enumOf(
            e?.direction,
            [...DIRECTIONS, 'stopped'],
            'RTCRtpTransceiverDirection',
          ),
        };
      });
      if (list.length !== s.extensionsToNegotiate.length) {
        throw domError(
          'The extensions cannot be added or removed.',
          'InvalidModificationError',
        );
      }
      list.forEach((e: Any, i: number) => {
        if (e.uri !== s.extensionsToNegotiate[i].uri) {
          throw domError(
            'The extensions cannot be reordered.',
            'InvalidModificationError',
          );
        }
        if (
          MANDATORY_EXTENSIONS.includes(e.uri) &&
          e.direction !== 'sendrecv'
        ) {
          throw domError(
            `${e.uri} is negotiated both ways, and cannot be ${e.direction}.`,
            'InvalidModificationError',
          );
        }
      });
      setToNegotiate(s, list);
    }
    getNegotiatedHeaderExtensions(): Any[] {
      const s = slotOf(this, 'transceiver');
      return s.extensionsToNegotiate.map((e: Any) => ({
        uri: e.uri,
        direction: s.negotiatedExtensions.some((n: Any) => n.uri === e.uri)
          ? e.direction === 'stopped'
            ? 'sendrecv'
            : e.direction
          : 'stopped',
      }));
    }
  }

  /** A transceiver's `[[HeaderExtensionsToNegotiate]]`, which the host
   *  offers and answers from. */
  const setToNegotiate = (s: Any, list: Any[]): void => {
    s.extensionsToNegotiate = list;
    call('rtcExtensions', s.id, stringify(list));
  };

  /** A transceiver of `pc`'s, the host's number `id`. */
  const makeTransceiver = (
    pc: Any,
    id: number,
    source: number,
    kind: string,
    direction: string,
    track: Any,
    streams: string[],
    encodings: Any[],
  ): Any => {
    const t = new RTCRtpTransceiver(TOKEN);
    const sender = new RTCRtpSender(TOKEN);
    const receiver = new RTCRtpReceiver(TOKEN);
    const caps = capabilitiesOf(kind, 'sender');
    const s: Any = {
      transceiver: true,
      self: t,
      pc,
      id,
      kind,
      mid: null,
      direction,
      currentDirection: null,
      stopping: false,
      stopped: false,
      transport: null,
      sender,
      receiver,
      receiving: false,
      remoteStreams: [] as Any[],
      codecPreferences: [],
      extensionsToNegotiate: (caps?.headerExtensions ?? []).map((e: Any) => ({
        uri: e.uri,
        direction: STOPPED_BY_DEFAULT.includes(e.uri) ? 'stopped' : 'sendrecv',
      })),
      negotiatedExtensions: [],
      /** Ever sent: an m-section negotiated it to send. */
      sent: false,
      /** Made by a remote offer not yet answered, which a rollback of it
       *  takes away. */
      fromRemoteOffer: false,
      /** Given a track by `addTrack`, which a rollback leaves it for. */
      addTracked: false,
      /** Stops telling the host its sender's track's output (`watchSent`). */
      unwatchSent: null,
    };
    apply(wmSet, slots, [t, s]);
    apply(wmSet, slots, [
      sender,
      {
        sender: true,
        tx: s,
        track,
        streams,
        encodings,
        parameters: null,
        lastReturned: null,
        dtmf: kind === 'audio' ? makeDtmf(sender) : null,
      },
    ]);
    apply(wmSet, slots, [
      receiver,
      {
        receiver: true,
        tx: s,
        track: media.track(kind, source, `remote ${kind}`, true),
        parameters: null,
        jitterBufferTarget: null,
      },
    ]);
    // a new transceiver negotiates what the first of its kind not stopping
    // does (webrtc-extensions, [[HeaderExtensionsToNegotiate]])
    for (const other of pc.transceivers) {
      const o = apply(wmGet, slots, [other]);
      if (!o || o.kind !== kind || o.stopping || o.stopped) continue;
      const list = o.extensionsToNegotiate.map((e: Any) => ({ ...e }));
      if (stringify(list) !== stringify(s.extensionsToNegotiate))
        setToNegotiate(s, list);
      break;
    }
    pc.transceivers.push(t);
    return t;
  };

  /**
   * Tells the host what a transceiver's sender sends from now on — a track's
   * source, its id and its output, then each change of its output — or
   * nothing. A sender of a disabled track sends black frames and silence,
   * and one of an ended track nothing, whatever else reads its source: a
   * clone, a `<video>` (Media Capture 4.3.1, WebRTC 1.0 5.2).
   */
  const sendTrack = (tx: Any, track: Any): void => {
    call(
      'rtcTrack',
      tx.id,
      track ? media.sourceOf(track) : -1,
      track?.id ?? '',
      track ? media.output(track) : 'ended',
    );
    watchSent(tx, track);
  };
  /** A sender's track's output, told to the host as it changes, until the
   *  sender is handed another or its transceiver stops. */
  const watchSent = (tx: Any, track: Any): void => {
    tx.unwatchSent?.();
    tx.unwatchSent = null;
    if (!track) return;
    let told = media.output(track);
    tx.unwatchSent = media.watchOutput(track, () => {
      const now = media.output(track);
      if (now === told) return;
      told = now;
      call('rtcTrackOutput', tx.id, now);
    });
  };

  /** Stops a transceiver's sending and receiving: `stop()`, a rejected
   *  m-section, `close()`. */
  const stopTransceiver = (s: Any, final: boolean, closing = false): void => {
    if (!s.stopping) {
      s.stopping = true;
      s.direction = 'stopped';
      s.unwatchSent?.();
      s.unwatchSent = null;
      const r = apply(wmGet, slots, [s.receiver]);
      // the receiver's track ends, and says so in a task of its own, but
      // where the connection closed, which ends it at once and tells
      // nothing (WebRTC 1.0, 4.4.1.1 and 5.4)
      if (closing) media.end(r.track, false);
      else setTimer(() => media.end(r.track, true), 0);
    }
    if (final) {
      s.stopped = true;
      s.currentDirection = 'stopped';
    }
  };

  // --- the connection ----------------------------------------------------------------

  /** Each connection's slot, by the number the host knows it by. */
  const connections = new Map<number, Any>();
  let connectionSeq = 0;

  const BUNDLE = ['balanced', 'max-compat', 'max-bundle'];

  /** An `RTCConfiguration` checked as the constructor checks it (WebRTC
   *  1.0, 4.4.1.1, "set a configuration"). */
  const configurationOf = (value: Any): Any => {
    const c = dictionary(value, 'RTCConfiguration');
    const servers: Any[] = [];
    if (c.iceServers !== undefined) {
      if (
        !c.iceServers ||
        typeof c.iceServers[Symbol.iterator] !== 'function'
      ) {
        throw typeError(
          "Failed to construct 'RTCPeerConnection': iceServers is not a sequence.",
        );
      }
      for (const raw of c.iceServers) {
        const server = dictionary(raw, 'RTCIceServer');
        if (server.urls === undefined) {
          throw typeError(
            "Failed to construct 'RTCPeerConnection': required member urls is undefined.",
          );
        }
        const urls: string[] =
          typeof server.urls === 'string'
            ? [server.urls]
            : server.urls && typeof server.urls[Symbol.iterator] === 'function'
              ? [...server.urls].map(String)
              : [String(server.urls)];
        if (!urls.length) {
          throw domError('An ICE server has no urls.', 'SyntaxError');
        }
        const username =
          server.username === undefined ? undefined : String(server.username);
        // a STUN username is shorter than 513 bytes (RFC 8489, 14.3), which
        // Chrome holds a TURN server's to at 509
        if (username !== undefined && username.length > 509) {
          throw domError(
            'The username is longer than 509 characters.',
            'InvalidAccessError',
          );
        }
        const credential =
          server.credential === undefined
            ? undefined
            : String(server.credential);
        for (const url of urls) {
          let parsed: Any;
          try {
            parsed = new URLClass(url);
          } catch {
            throw domError(`'${url}' is not a URL.`, 'SyntaxError');
          }
          const scheme = String(parsed.protocol).slice(0, -1);
          if (!['stun', 'stuns', 'turn', 'turns'].includes(scheme)) {
            throw domError(
              `'${url}' is not a STUN or TURN URL.`,
              'SyntaxError',
            );
          }
          // "validate an ICE server URL": an opaque path, which is a host
          // and a port alone (RFC 7064 and RFC 7065, 3.1)
          const path = String(parsed.pathname);
          if (
            parsed.host !== '' ||
            path.startsWith('/') ||
            /[/@\\]/.test(path)
          ) {
            throw domError(`'${url}' is not a host and a port.`, 'SyntaxError');
          }
          if (parsed.hash || url.includes('#')) {
            throw domError(`'${url}' has a fragment.`, 'SyntaxError');
          }
          let hostAndPort: Any;
          try {
            hostAndPort = new URLClass('https://' + path);
          } catch {
            throw domError(`'${url}' is not a host and a port.`, 'SyntaxError');
          }
          if (
            hostAndPort.username ||
            hostAndPort.password ||
            hostAndPort.pathname !== '/' ||
            hostAndPort.search
          ) {
            throw domError(`'${url}' is not a host and a port.`, 'SyntaxError');
          }
          const query = String(parsed.search).slice(1);
          if ((scheme === 'stun' || scheme === 'stuns') && parsed.search) {
            throw domError(`'${url}' has a query.`, 'SyntaxError');
          }
          if (
            parsed.search &&
            query !== 'transport=udp' &&
            query !== 'transport=tcp'
          ) {
            throw domError(
              `'${url}' has a query that is not a transport.`,
              'SyntaxError',
            );
          }
          // a TURN server's username may be empty (RFC 8489, 14.3), and
          // its credential an OpaqueString, which may not (RFC 8265, 4.1)
          if (
            (scheme === 'turn' || scheme === 'turns') &&
            (username === undefined ||
              credential === undefined ||
              credential === '')
          ) {
            throw domError(
              `'${url}' is a TURN server, which needs a username and a credential.`,
              'InvalidAccessError',
            );
          }
        }
        // a string reads back as a list of one, as every browser has it
        const kept: Any = { urls: urls.slice() };
        if (username !== undefined) kept.username = username;
        if (credential !== undefined) kept.credential = credential;
        servers.push({ kept, urls, username, credential });
      }
    }
    const certificates: Any[] = [];
    if (c.certificates !== undefined) {
      for (const cert of c.certificates) {
        if (!isA(cert, 'certificate')) {
          throw typeError(
            "Failed to construct 'RTCPeerConnection': a certificate is not an RTCCertificate.",
          );
        }
        const held = apply(wmGet, slots, [cert]);
        if (held.expires <= Date.now()) {
          throw domError('A certificate has expired.', 'InvalidAccessError');
        }
        // one another origin made is no certificate of this one's
        if (
          held.realm !== REALM &&
          (held.origin === 'null' || held.origin !== documentOrigin())
        ) {
          throw domError(
            'A certificate is of another origin.',
            'InvalidAccessError',
          );
        }
        certificates.push(cert);
      }
    }
    return {
      servers,
      iceTransportPolicy: enumOf(
        c.iceTransportPolicy,
        ['relay', 'all'],
        'RTCIceTransportPolicy',
        'all',
      ),
      bundlePolicy: enumOf(
        c.bundlePolicy,
        BUNDLE,
        'RTCBundlePolicy',
        'balanced',
      ),
      rtcpMuxPolicy: enumOf(
        c.rtcpMuxPolicy,
        ['require'],
        'RTCRtcpMuxPolicy',
        'require',
      ),
      iceCandidatePoolSize:
        c.iceCandidatePoolSize === undefined
          ? 0
          : enforce(c.iceCandidatePoolSize, 255, 'iceCandidatePoolSize'),
      certificates,
    };
  };

  /** A configuration as the host is handed it. */
  const requestOf = (config: Any): string =>
    stringify({
      iceServers: config.servers.map((s: Any) => ({
        urls: s.urls,
        ...(s.username !== undefined ? { username: s.username } : {}),
        ...(s.credential !== undefined ? { credential: s.credential } : {}),
      })),
      iceTransportPolicy: config.iceTransportPolicy,
      bundlePolicy: config.bundlePolicy,
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: config.iceCandidatePoolSize,
      certificates: config.certificates.map(
        (c: Any) => apply(wmGet, slots, [c]).id,
      ),
    });

  /** WebRTC 1.0, 4.4.1.2, "chain an operation". */
  const chain = (s: Any, operation: () => Promise<Any>): Promise<Any> => {
    if (s.closed) return rejected(invalidState());
    let resolveP: Any;
    let rejectP: Any;
    const p = new P((a: Any, b: Any) => {
      resolveP = a;
      rejectP = b;
    });
    const run = (): void => {
      let result: Any;
      try {
        result = operation();
      } catch (error) {
        result = rejected(error);
      }
      then(
        resolved(result),
        (value: Any) => {
          if (s.closed) return;
          resolveP(value);
          then(p, after, after);
        },
        (error: Any) => {
          if (s.closed) return;
          rejectP(error);
          then(p, after, after);
        },
      );
    };
    const after = (): void => {
      if (s.closed) return;
      s.ops.shift();
      if (s.ops.length) {
        s.ops[0]();
        return;
      }
      if (!s.updateOnEmpty) return;
      s.updateOnEmpty = false;
      updateNegotiationNeeded(s);
    };
    s.ops.push(run);
    if (s.ops.length === 1) run();
    return p;
  };

  /** A legacy callback form's promise: the callbacks are called, and it
   *  resolves with nothing. */
  const legacy = (p: Promise<Any>, success: Any, failure: Any): Promise<void> =>
    then(
      p,
      (value: Any) => {
        if (typeof success === 'function') success(value);
      },
      (error: Any) => {
        if (typeof failure === 'function') failure(error);
      },
    );

  /** WebRTC 1.0, 4.7.3, "check if negotiation is needed". */
  const negotiationNeeded = (s: Any): boolean => {
    if (s.iceRestart) return true;
    const d = descriptionsOf(s);
    const local = sectionsOf(d.currentLocal);
    const remote = sectionsOf(d.currentRemote);
    if (s.anyChannel && !local.some((m) => m.kind === 'application'))
      return true;
    const isOffer = s.types.currentLocal === 'offer';
    for (const tx of s.transceivers) {
      const t = apply(wmGet, slots, [tx]);
      if (t.stopping && !t.stopped) return true;
      if (t.stopped) {
        const l = local.find((m) => m.mid === t.mid);
        const r = remote.find((m) => m.mid === t.mid);
        if (t.mid !== null && ((l && l.port !== 0) || (r && r.port !== 0))) {
          return true;
        }
        continue;
      }
      const section =
        t.mid === null ? undefined : local.find((m) => m.mid === t.mid);
      if (!section) return true;
      if (sends(t.direction)) {
        const ids = apply(wmGet, slots, [t.sender]).streams as string[];
        if (
          section.streams.length !== ids.length ||
          ids.some((id) => !section.streams.includes(id))
        ) {
          return true;
        }
      }
      const r = remote.find((m) => m.mid === t.mid);
      if (isOffer) {
        if (
          section.direction !== t.direction &&
          (!r || reversed(r.direction) !== t.direction)
        ) {
          return true;
        }
      } else if (r) {
        const offered = reversed(r.direction);
        const answer = directionOf(
          sends(t.direction) && sends(offered),
          receives(t.direction) && receives(offered),
        );
        if (section.direction !== answer) return true;
      }
    }
    return false;
  };

  /** The ICE username fragments a description holds. */
  const ufragsOf = (sdp: string | null): string[] =>
    sdp ? [...sdp.matchAll(/^a=ice-ufrag:(\S+)/gm)].map((m: Any) => m[1]) : [];

  /** WebRTC 1.0, 4.7.3, "update the negotiation-needed flag". */
  const updateNegotiationNeeded = (s: Any): void => {
    if (s.closed) return;
    if (s.ops.length) {
      s.updateOnEmpty = true;
      return;
    }
    setTimer(() => {
      if (s.closed) return;
      if (s.ops.length) {
        s.updateOnEmpty = true;
        return;
      }
      if (s.signaling !== 'stable') return;
      if (!negotiationNeeded(s)) {
        s.negotiationNeeded = false;
        return;
      }
      if (s.negotiationNeeded) return;
      s.negotiationNeeded = true;
      simple(s.self, 'negotiationneeded');
    }, 0);
  };

  const descriptionsOf = (s: Any): Any => {
    const text = call('rtcDescriptions', s.id);
    const d =
      typeof text === 'string'
        ? parse(text)
        : {
            currentLocal: null,
            pendingLocal: null,
            currentRemote: null,
            pendingRemote: null,
          };
    // the candidates in them are those the page has heard of
    d.currentLocal = surfacedOnly(s, d.currentLocal);
    d.pendingLocal = surfacedOnly(s, d.pendingLocal);
    return d;
  };

  /** A description the connection answers with: the same object while its
   *  text is the same. */
  const descriptionObject = (
    s: Any,
    type: string | null,
    sdp: string | null,
  ): Any => {
    if (sdp === null || type === null) return null;
    const key = `${type}\n${sdp}`;
    let d = s.described.get(key);
    if (!d) {
      if (s.described.size > 16) s.described.clear();
      d = new RTCSessionDescription({ type, sdp });
      s.described.set(key, d);
    }
    return d;
  };

  /** The transports the connection uses now: its transceivers' that are not
   *  stopped, and its SCTP transport. */
  const transportsInUse = (s: Any): number[] => {
    const used = new Set<number>();
    for (const tx of s.transceivers) {
      const t = apply(wmGet, slots, [tx]);
      if (!t.stopped && t.transport !== null) used.add(t.transport);
    }
    if (s.sctpTransport !== null) used.add(s.sctpTransport);
    return [...used];
  };

  /** The mid and m-line index of the first section a transport carries. */
  const sectionOfTransport = (
    s: Any,
    id: number,
  ): [string | null, number | null] => {
    const local = sectionsOf(
      (() => {
        const d = descriptionsOf(s);
        return d.pendingLocal ?? d.currentLocal;
      })(),
    );
    for (const tx of s.transceivers) {
      const t = apply(wmGet, slots, [tx]);
      if (t.transport === id && t.mid !== null) {
        const at = local.findIndex((m) => m.mid === t.mid);
        return [t.mid, at >= 0 ? at : null];
      }
    }
    if (local.length) return [local[0].mid, 0];
    return [null, null];
  };

  /** The remote offer a local answer answers: current once it is set. */
  const remoteOfferOf = (s: Any): string | null =>
    descriptionsOf(s).currentRemote;

  /** A sender's encodings narrowed to the rids the other side receives, in
   *  the sender's order, and to the first where it receives none of them
   *  or no simulcast at all (WebRTC 1.0, 4.4.1.6). */
  const narrowEncodings = (sender: Any, rids: string[] | null): void => {
    if (sender.encodings.length <= 1) return;
    const kept = rids?.length
      ? sender.encodings.filter((e: Any) => rids.includes(e.rid))
      : [];
    sender.encodings = kept.length ? kept : [sender.encodings[0]];
  };

  /** The host told a sender's encodings where they are not what it was
   *  last told: what its layers encode and its descriptions name. */
  const tellEncodings = (t: Any): void => {
    const sender = apply(wmGet, slots, [t.sender]);
    const text = stringify(sender.encodings);
    if (sender.toldEncodings === text) return;
    sender.toldEncodings = text;
    call('rtcEncodings', t.id, text);
  };

  /** What a description that was applied left: the connection's mirror of
   *  its transceivers brought up to date, and the tracks it adds and takes
   *  away, to be told. */
  const applyState = (
    s: Any,
    state: Any,
    remote: boolean,
    type: string,
    sdp = '',
  ): { added: Any[]; removed: [Any, Any][] } => {
    const answered =
      remote && (type === 'answer' || type === 'pranswer')
        ? sectionsOf(sdp)
        : null;
    const added: Any[] = [];
    const removed: [Any, Any][] = [];
    const seen = new Set<number>();
    for (const st of state.transceivers ?? []) {
      if (s.discarded.has(st.id)) continue;
      seen.add(st.id);
      let tx = s.transceivers.find(
        (x: Any) => apply(wmGet, slots, [x]).id === st.id,
      );
      if (!tx) {
        tx = makeTransceiver(
          s,
          st.id,
          st.source,
          st.kind,
          'recvonly',
          null,
          [],
          encodingsOf([], st.kind),
        );
        // what a rollback of this remote offer takes away again
        if (remote && type === 'offer') {
          apply(wmGet, slots, [tx]).fromRemoteOffer = true;
        }
      }
      const t = apply(wmGet, slots, [tx]);
      if (t.stopped) {
        // a stopped transceiver keeps its mid until an answer takes its
        // m-section away, and nothing else of it is negotiated (WebRTC
        // 1.0, 4.4.1.6)
        if (type === 'answer') t.mid = null;
        continue;
      }
      t.mid = st.mid;
      // one stopping goes on being negotiated until it is stopped
      if (!t.stopped) {
        t.currentDirection = st.currentDirection;
      }
      if (sends(st.currentDirection)) t.sent = true;
      // a local description sets the transports, and a remote answer, but
      // a remote offer leaves them as they were (WebRTC 1.0, 4.4.1.6)
      if (!(remote && type === 'offer')) {
        t.transport =
          st.sender?.transport ?? st.receiver?.transport ?? t.transport;
      }
      if (type === 'answer' || type === 'pranswer') {
        // what a sender sends and a receiver receives is what an answer
        // negotiated, and nothing before one: [[SendCodecs]] and
        // [[ReceiveCodecs]] are set as an answer is applied (WebRTC 1.0,
        // 4.4.1.6), and an encoding's codec the answer left out goes with
        // it (5.2)
        const sender = apply(wmGet, slots, [t.sender]);
        sender.parameters = st.sender?.parameters ?? null;
        apply(wmGet, slots, [t.receiver]).parameters =
          st.receiver?.parameters ?? null;
        const sendable: Any[] = sender.parameters?.codecs ?? [];
        for (const e of sender.encodings) {
          if (e.codec && !sendable.some((c: Any) => sameCodec(c, e.codec))) {
            delete e.codec;
          }
        }
        // an answer narrows the encodings a sender sends to the rids the
        // remote side's `a=simulcast` receives, in the sender's order, and
        // one with none to the first: a remote answer's, or the remote
        // offer a local answer answers (WebRTC 1.0, 4.4.1.6)
        const section = (
          answered ?? (remote ? null : sectionsOf(remoteOfferOf(s)))
        )?.find((m) => m.mid === st.mid);
        if (section) narrowEncodings(sender, section.simulcastRecv);
        sender.beforeOffer = null;
      } else if (remote && type === 'offer' && t.kind === 'video') {
        // a remote offer that asks to receive simulcast makes a sender of
        // one encoding with no rid send it, its rids the offer's in its
        // order, each half the size of the next; one simulcast already
        // waits for the answer to narrow it (WebRTC 1.0, 4.4.1.6)
        const sender = apply(wmGet, slots, [t.sender]);
        const rids = sectionsOf(sdp).find(
          (m) => m.mid === st.mid,
        )?.simulcastRecv;
        const [only] = sender.encodings;
        if (
          rids?.length &&
          sender.encodings.length === 1 &&
          only.rid === undefined
        ) {
          sender.beforeOffer = sender.encodings;
          const n = Math.min(rids.length, MAX_ENCODINGS);
          sender.encodings = rids.slice(0, n).map((rid: string, i: number) => ({
            rid,
            active: true,
            priority: only.priority ?? 'low',
            networkPriority: only.networkPriority ?? 'low',
            scaleResolutionDownBy: 2 ** (n - i - 1),
          }));
        }
      }
      t.negotiatedExtensions = st.headerExtensions ?? [];
      // what a remote answer did not take is stopped, and is not offered
      // again until a page asks for it: the negotiated list becomes the one
      // to negotiate (webrtc-extensions, "set a session description"). Not
      // a local answer's: an extension the answerer let go is answered
      // again where the offerer offers it anew, which is what Chrome does
      if (
        remote &&
        type === 'answer' &&
        answered?.some((m: Any) => m.mid === st.mid)
      ) {
        const reflected = t.extensionsToNegotiate.map((e: Any) =>
          e.direction !== 'stopped' &&
          !t.negotiatedExtensions.some((n: Any) => n.uri === e.uri)
            ? { uri: e.uri, direction: 'stopped' }
            : e,
        );
        if (stringify(reflected) !== stringify(t.extensionsToNegotiate))
          setToNegotiate(t, reflected);
      }
      if (st.stopped) {
        // stopped, its m-section is no longer its
        if (!t.stopped) {
          stopTransceiver(t, true);
          t.mid = null;
        }
        continue;
      }
      // a remote description that rejects its m-section stops it, at once
      // (WebRTC 1.0, 4.4.1.6)
      if (st.direction === 'stopped' && !t.stopping) {
        stopTransceiver(t, remote);
        if (remote) continue;
      }
      // what the description says the transceiver now receives (WebRTC
      // 1.0, 4.4.1.6, "process the addition" and "the removal of a remote
      // track")
      // a local description only ever takes a track away: an answer that
      // no longer receives
      const receiving = remote
        ? type === 'offer'
          ? sends(st.remoteDirection)
          : receives(st.currentDirection)
        : type === 'answer' || type === 'pranswer'
          ? t.receiving && receives(st.currentDirection)
          : t.receiving;
      const r = apply(wmGet, slots, [t.receiver]);
      if (remote && receiving) {
        // a stream named twice is one stream
        let ids: string[] = (st.receiver?.streams ?? []).filter(
          (id: string, i: number, all: string[]) => all.indexOf(id) === i,
        );
        // a media-level msid names its streams; where there is none, its
        // sources' do; and a track no msid names at all is in the one
        // default stream (RFC 8829, 5.10)
        const section = ids.length
          ? null
          : sectionsOf(sdp).find((m) => m.mid === st.mid);
        if (section && !section.streams.length) {
          ids = section.msid ? section.ssrcStreams : ['default'];
        }
        const streams = ids.map((id) => streamOf(s, id));
        for (const old of t.remoteStreams) {
          if (!streams.includes(old)) removed.push([old, r.track]);
        }
        const fresh = streams.filter((x: Any) => !t.remoteStreams.includes(x));
        t.remoteStreams = streams;
        // a track newly received, or one a stream newly holds, is told
        // (WebRTC 1.0, 4.4.1.6: the addition of a remote track)
        if (!t.receiving || fresh.length) added.push({ tx, streams, fresh });
      } else if (!receiving && t.receiving) {
        for (const old of t.remoteStreams) removed.push([old, r.track]);
        t.remoteStreams = [];
      }
      t.receiving = receiving;
    }
    let dropSctp = false;
    if (type === 'rollback') {
      // a transceiver the rolled-back offer made is gone with it, stopped,
      // unless `addTrack` gave it a track since — `replaceTrack` and a
      // direction do not keep it — and a mid only it gave is taken back
      // (WebRTC 1.0, 4.4.1.6)
      const d = descriptionsOf(s);
      const current = [
        ...sectionsOf(d.currentLocal),
        ...sectionsOf(d.currentRemote),
      ];
      const kept = new Set(current.map((m) => m.mid));
      // and so is an SCTP transport it made: one no current description
      // has a data m-section for (WebRTC 1.0, 4.4.1.6, "if description is
      // of type rollback")
      dropSctp = !current.some((m) => m.kind === 'application' && m.port !== 0);
      // the encodings a rolled-back remote offer made simulcast are what
      // they were before it
      if (remote) {
        for (const x of s.transceivers) {
          const sender = apply(wmGet, slots, [apply(wmGet, slots, [x]).sender]);
          if (sender.beforeOffer) {
            sender.encodings = sender.beforeOffer;
            sender.beforeOffer = null;
          }
        }
      }
      if (dropSctp) {
        s.sctpTransport = null;
        channels.sctpDropped(s);
      }
      s.transceivers = s.transceivers.filter((x: Any) => {
        const t = apply(wmGet, slots, [x]);
        if (t.mid !== null && !kept.has(t.mid)) t.mid = null;
        // and a transceiver with no m-section has no transport
        if (t.mid === null) t.transport = null;
        const made = remote && t.fromRemoteOffer && !t.addTracked;
        if (seen.has(t.id) && !made) {
          if (remote) t.fromRemoteOffer = false;
          return true;
        }
        stopTransceiver(t, true);
        t.mid = null;
        t.transport = null;
        if (seen.has(t.id)) {
          // the stack kept it: it is stopped there, and the page never
          // sees it again
          call('rtcStopTransceiver', t.id);
          s.discarded.add(t.id);
        }
        return false;
      });
    } else if (type === 'answer') {
      // and a stopped one goes once an answer is applied, and none a
      // remote offer made is a rollback's to take away any more
      s.transceivers = s.transceivers.filter((x: Any) => {
        const t = apply(wmGet, slots, [x]);
        t.fromRemoteOffer = false;
        if (!t.stopped) return true;
        // whether or not the stack still listed it
        t.mid = null;
        t.transport = null;
        return false;
      });
    }
    for (const x of s.transceivers) tellEncodings(apply(wmGet, slots, [x]));
    if (state.sctp && !dropSctp) {
      s.sctpTransport = state.sctp.transport;
      channels.sctpNegotiated(
        s,
        state.sctp,
        transportOf(s, state.sctp.transport).dtls,
      );
    }
    return { added, removed };
  };

  const SIGNALING_LOCAL: Record<string, Record<string, string>> = {
    offer: {
      stable: 'have-local-offer',
      'have-local-offer': 'have-local-offer',
    },
    answer: { 'have-remote-offer': 'stable', 'have-local-pranswer': 'stable' },
    pranswer: {
      'have-remote-offer': 'have-local-pranswer',
      'have-local-pranswer': 'have-local-pranswer',
    },
    rollback: { 'have-local-offer': 'stable' },
  };
  const SIGNALING_REMOTE: Record<string, Record<string, string>> = {
    offer: {
      stable: 'have-remote-offer',
      'have-remote-offer': 'have-remote-offer',
    },
    answer: { 'have-local-offer': 'stable', 'have-remote-pranswer': 'stable' },
    pranswer: {
      'have-local-offer': 'have-remote-pranswer',
      'have-remote-pranswer': 'have-remote-pranswer',
    },
    rollback: { 'have-remote-offer': 'stable' },
  };

  /** WebRTC 1.0, 4.4.1.5 and 4.4.1.6, "set the RTCSessionDescription". */
  const setDescription = (
    s: Any,
    remote: boolean,
    type: string,
    sdp: string,
  ): Promise<void> => {
    const table = remote ? SIGNALING_REMOTE : SIGNALING_LOCAL;
    const next = table[type]?.[s.signaling];
    if (!next) {
      return rejected(
        invalidState(
          `Cannot set a ${remote ? 'remote' : 'local'} ${type} in state ${s.signaling}.`,
        ),
      );
    }
    return then(
      ask((req) =>
        call(
          remote ? 'rtcSetRemote' : 'rtcSetLocal',
          s.id,
          req,
          stringify({ type, sdp }),
        ),
      ),
      (state: Any) => {
        if (s.closed) return;
        if (!remote) s.everSetLocal = true;
        // which descriptions are current and which pending, and of what type
        const ty = s.types;
        if (type === 'rollback') {
          if (remote) ty.pendingRemote = null;
          else ty.pendingLocal = null;
        } else if (type === 'answer') {
          if (remote) {
            ty.currentRemote = 'answer';
            ty.currentLocal = ty.pendingLocal ?? ty.currentLocal;
          } else {
            ty.currentLocal = 'answer';
            ty.currentRemote = ty.pendingRemote ?? ty.currentRemote;
          }
          ty.pendingLocal = null;
          ty.pendingRemote = null;
        } else if (remote) {
          ty.pendingRemote = type;
        } else {
          ty.pendingLocal = type;
        }
        if (remote && type !== 'rollback') {
          s.canTrickle = /^a=ice-options:.*\btrickle\b/m.test(sdp);
        }
        // the credentials to replace go once a local description that
        // holds none of them is set, or a remote answer to one
        if (
          s.iceRestart &&
          type !== 'rollback' &&
          (!remote || type !== 'offer')
        ) {
          const local = remote ? descriptionsOf(s).currentLocal : sdp;
          if (!ufragsOf(local).some((u) => s.iceCredentials.has(u))) {
            s.iceRestart = false;
            s.iceCredentials = new Set();
          }
        }
        const { added, removed } = applyState(s, state, remote, type, sdp);
        const changed = s.signaling !== next;
        s.signaling = next;
        if (changed) simple(s.self, 'signalingstatechange');
        for (const [stream, track] of removed) media.removeTrack(stream, track);
        for (const { tx, streams, fresh } of added) {
          const r = apply(wmGet, slots, [apply(wmGet, slots, [tx]).receiver]);
          for (const stream of fresh) media.addTrack(stream, r.track);
          fire(
            s.self,
            new RTCTrackEvent('track', {
              receiver: apply(wmGet, slots, [tx]).receiver,
              track: r.track,
              streams,
              transceiver: tx,
            }),
          );
        }
        if (next === 'stable') {
          // a flag that was raised before this description and still is
          // after it is told again, in a task of its own, if it holds by
          // then (WebRTC 1.0, 4.4.1.6): what the offer left out — a
          // channel made while it was out — is asked for anew
          const was = s.negotiationNeeded;
          updateNegotiationNeeded(s);
          if (was) {
            setTimer(() => {
              if (s.closed || !s.negotiationNeeded) return;
              // the flag is worked out late here, so it is worked out again
              if (s.signaling !== 'stable') return;
              if (!negotiationNeeded(s)) {
                s.negotiationNeeded = false;
                return;
              }
              simple(s.self, 'negotiationneeded');
            }, 0);
          }
        }
        updateStates(s);
      },
    );
  };

  class RTCTrackEvent extends Event {
    constructor(type: string, init: Any) {
      const i = dictionary(init, 'RTCTrackEventInit');
      for (const key of ['receiver', 'track', 'transceiver']) {
        if (i[key] === undefined) {
          throw typeError(
            `Failed to construct 'RTCTrackEvent': required member ${key} is undefined.`,
          );
        }
      }
      super(type, i);
      apply(wmSet, slots, [
        this,
        {
          trackEvent: true,
          receiver: i.receiver,
          track: i.track,
          streams: freeze([...(i.streams ?? [])]),
          transceiver: i.transceiver,
        },
      ]);
    }
    get receiver(): Any {
      return slotOf(this, 'trackEvent').receiver;
    }
    get track(): Any {
      return slotOf(this, 'trackEvent').track;
    }
    get streams(): Any {
      return slotOf(this, 'trackEvent').streams;
    }
    get transceiver(): Any {
      return slotOf(this, 'trackEvent').transceiver;
    }
  }

  /** This realm, which a certificate made here keeps: an opaque origin is
   *  no other's, so a certificate of one is its realm's alone. */
  const REALM = freeze(Object.create(null));
  const documentOrigin = (): string => String(call('documentOrigin'));
  /** A certificate of this realm's, from what it holds: its host's number,
   *  its expiry and fingerprints, the origin that made it and the realm it
   *  was made in, null where it came from another. */
  const certificateOf = (held: Any): Any => {
    const cert = new RTCCertificate(TOKEN);
    apply(wmSet, slots, [cert, { certificate: true, ...held }]);
    return cert;
  };
  D.certificates?.({
    is: (value: Any) => isA(value, 'certificate'),
    // the serialization steps: its expiry, its certificate and keying
    // material by the host's handle, and its origin (WebRTC 1.0, 4.9)
    data: (value: Any) => {
      const c = apply(wmGet, slots, [value]);
      return {
        id: c.id,
        expires: c.expires,
        fingerprints: c.fingerprints,
        origin: c.origin,
      };
    },
    from: (data: Any) =>
      certificateOf({
        id: Number(data.id),
        expires: Number(data.expires),
        fingerprints: Array.isArray(data.fingerprints)
          ? data.fingerprints.map((f: Any) => ({
              algorithm: String(f.algorithm),
              value: String(f.value),
            }))
          : [],
        origin: String(data.origin),
        realm: null,
      }),
  });

  class RTCCertificate {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
    }
    get expires(): number {
      return slotOf(this, 'certificate').expires;
    }
    getFingerprints(): Any[] {
      // a fingerprint is lower-case hexadecimal (WebRTC 1.0, 4.9.2, after
      // RFC 4572's syntax), whatever case the stack wrote it in
      return slotOf(this, 'certificate').fingerprints.map((f: Any) => ({
        ...f,
        value: String(f.value).toLowerCase(),
      }));
    }
  }

  class RTCPeerConnection extends EventTarget {
    constructor(configuration: Any = undefined) {
      super();
      const config = configurationOf(configuration);
      const id = ++connectionSeq;
      const s: Any = {
        pc: true,
        self: this,
        id,
        closed: false,
        signaling: 'stable',
        gathering: 'new',
        iceState: 'new',
        connState: 'new',
        ops: [] as Any[],
        updateOnEmpty: false,
        negotiationNeeded: false,
        lastOffer: '',
        lastAnswer: '',
        // every description createOffer and createAnswer made, the latest
        // last: one of them that is no longer the last is refused
        created: [] as string[],
        transceivers: [] as Any[],
        config,
        iceRestart: false,
        iceCredentials: new Set<string>(),
        transports: new Map(),
        sctpTransport: null,
        anyChannel: false,
        canTrickle: null,
        types: {
          currentLocal: null,
          pendingLocal: null,
          currentRemote: null,
          pendingRemote: null,
        },
        streams: new Map(),
        described: new Map(),
        everSetLocal: false,
        /** The transceivers a remote rollback took away while the stack
         *  kept them, by their numbers: the page never sees them again. */
        discarded: new Set<number>(),
      };
      apply(wmSet, slots, [this, s]);
      connections.set(id, s);
      call('rtcOpen', id, requestOf(config));
    }

    static generateCertificate(keygen: Any): Promise<Any> {
      let alg: Any;
      try {
        alg =
          typeof keygen === 'string'
            ? { name: keygen }
            : dictionary(keygen, 'AlgorithmIdentifier');
      } catch (error) {
        return rejected(error);
      }
      const name = String(alg.name ?? '');
      let normal: Any;
      if (name.toUpperCase() === 'ECDSA' && alg.namedCurve === 'P-256') {
        normal = { name: 'ECDSA', namedCurve: 'P-256' };
      } else if (
        name.toUpperCase() === 'RSASSA-PKCS1-V1_5' &&
        String(alg.hash?.name ?? alg.hash).toUpperCase() === 'SHA-256'
      ) {
        normal = {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: Number(alg.modulusLength ?? 2048),
          publicExponent: 65537,
          hash: 'SHA-256',
        };
      } else {
        return rejected(
          domError(
            'The algorithm is not one a certificate can be made with.',
            'NotSupportedError',
          ),
        );
      }
      // `RTCCertificateExpiration`'s `[EnforceRange] unsigned long long`
      let lifetime = 30 * 86400e3;
      if (typeof keygen === 'object' && alg.expires !== undefined) {
        const n = Number(alg.expires);
        if (
          !Number.isFinite(n) ||
          Math.trunc(n) < 0 ||
          Math.trunc(n) > Number.MAX_SAFE_INTEGER
        ) {
          return rejected(
            typeError(
              "Failed to execute 'generateCertificate': expires is outside the range of an unsigned long long.",
            ),
          );
        }
        lifetime = Math.trunc(n);
      }
      const expires = Date.now() + Math.min(lifetime, 365 * 86400e3);
      return then(
        ask((req) => call('rtcCertificate', req, stringify(normal), expires)),
        (made: Any) =>
          certificateOf({
            id: made.id,
            expires: made.expires,
            fingerprints: made.fingerprints,
            origin: documentOrigin(),
            realm: REALM,
          }),
      );
    }

    get localDescription(): Any {
      const s = slotOf(this, 'pc');
      const d = descriptionsOf(s);
      return d.pendingLocal !== null
        ? descriptionObject(s, s.types.pendingLocal, d.pendingLocal)
        : descriptionObject(s, s.types.currentLocal, d.currentLocal);
    }
    get currentLocalDescription(): Any {
      const s = slotOf(this, 'pc');
      return descriptionObject(
        s,
        s.types.currentLocal,
        descriptionsOf(s).currentLocal,
      );
    }
    get pendingLocalDescription(): Any {
      const s = slotOf(this, 'pc');
      return descriptionObject(
        s,
        s.types.pendingLocal,
        descriptionsOf(s).pendingLocal,
      );
    }
    get remoteDescription(): Any {
      const s = slotOf(this, 'pc');
      const d = descriptionsOf(s);
      return d.pendingRemote !== null
        ? descriptionObject(s, s.types.pendingRemote, d.pendingRemote)
        : descriptionObject(s, s.types.currentRemote, d.currentRemote);
    }
    get currentRemoteDescription(): Any {
      const s = slotOf(this, 'pc');
      return descriptionObject(
        s,
        s.types.currentRemote,
        descriptionsOf(s).currentRemote,
      );
    }
    get pendingRemoteDescription(): Any {
      const s = slotOf(this, 'pc');
      return descriptionObject(
        s,
        s.types.pendingRemote,
        descriptionsOf(s).pendingRemote,
      );
    }
    get signalingState(): string {
      return slotOf(this, 'pc').signaling;
    }
    get iceGatheringState(): string {
      return slotOf(this, 'pc').gathering;
    }
    get iceConnectionState(): string {
      const s = slotOf(this, 'pc');
      return s.closed ? 'closed' : s.iceState;
    }
    get connectionState(): string {
      const s = slotOf(this, 'pc');
      return s.closed ? 'closed' : s.connState;
    }
    get canTrickleIceCandidates(): Any {
      return slotOf(this, 'pc').canTrickle;
    }
    get sctp(): Any {
      return channels.sctpOf(slotOf(this, 'pc'));
    }

    createOffer(a?: Any, b?: Any, c?: Any): Promise<Any> {
      if (typeof a === 'function') return legacy(this.createOffer(c), a, b);
      let s: Any;
      let options: Any;
      try {
        s = slotOf(this, 'pc');
        options = dictionary(a, 'RTCOfferOptions');
      } catch (error) {
        return rejected(error);
      }
      return chain(s, () => {
        if (s.closed) return rejected(invalidState());
        if (s.signaling !== 'stable' && s.signaling !== 'have-local-offer') {
          return rejected(
            invalidState(`Cannot create an offer in state ${s.signaling}.`),
          );
        }
        legacyOfferOptions(s, options);
        return then(
          ask((req) =>
            call(
              'rtcOffer',
              s.id,
              req,
              options.iceRestart === true || s.iceRestart,
            ),
          ),
          (sdp: string) => {
            s.lastOffer = sdp;
            noteCreated(s, sdp);
            return { type: 'offer', sdp };
          },
        );
      });
    }
    createAnswer(a?: Any, b?: Any): Promise<Any> {
      if (typeof a === 'function') return legacy(this.createAnswer(), a, b);
      let s: Any;
      try {
        s = slotOf(this, 'pc');
      } catch (error) {
        return rejected(error);
      }
      return chain(s, () => {
        if (s.closed) return rejected(invalidState());
        if (
          s.signaling !== 'have-remote-offer' &&
          s.signaling !== 'have-local-pranswer'
        ) {
          return rejected(
            invalidState(`Cannot create an answer in state ${s.signaling}.`),
          );
        }
        return then(
          ask((req) => call('rtcAnswer', s.id, req)),
          (sdp: string) => {
            s.lastAnswer = sdp;
            noteCreated(s, sdp);
            return { type: 'answer', sdp };
          },
        );
      });
    }
    setLocalDescription(description?: Any, b?: Any, c?: Any): Promise<void> {
      if (typeof b === 'function' || typeof c === 'function') {
        return legacy(this.setLocalDescription(description), b, c);
      }
      let s: Any;
      let d: Any;
      try {
        s = slotOf(this, 'pc');
        d = dictionary(description, 'RTCLocalSessionDescriptionInit');
        if (d.type !== undefined) enumOf(d.type, SDP_TYPES, 'RTCSdpType');
      } catch (error) {
        return rejected(error);
      }
      const given = d.type === undefined ? undefined : String(d.type);
      const sdpGiven = d.sdp === undefined ? '' : String(d.sdp);
      return chain(s, () => {
        if (s.closed) return rejected(invalidState());
        const type =
          given ??
          (s.signaling === 'stable' ||
          s.signaling === 'have-local-offer' ||
          s.signaling === 'have-remote-pranswer'
            ? 'offer'
            : 'answer');
        if (type === 'rollback')
          return setDescription(s, false, 'rollback', '');
        // a type the state does not take is refused before what it holds
        if (!SIGNALING_LOCAL[type]?.[s.signaling]) {
          return rejected(
            invalidState(`Cannot set a local ${type} in state ${s.signaling}.`),
          );
        }
        if (sdpGiven !== '') {
          const last = type === 'offer' ? s.lastOffer : s.lastAnswer;
          // what WebRTC 1.0 refuses is any change at all; Chrome takes a
          // description a page changed, and Meet adds its simulcast streams
          // and header extensions to every offer before it sets it. What
          // Chrome still refuses is one that is not this connection's last:
          // an earlier one, or one whose ICE credentials and fingerprint
          // are another's
          if (
            sdpGiven !== last &&
            (s.created.includes(sdpGiven) ||
              credentialsOf(sdpGiven) !== credentialsOf(last))
          ) {
            return rejected(
              domError(
                'The description is not the last one created: it was modified.',
                'InvalidModificationError',
              ),
            );
          }
          return setDescription(s, false, type, sdpGiven);
        }
        // no description: the one the state calls for, made now
        if (type === 'offer') {
          if (s.signaling !== 'stable' && s.signaling !== 'have-local-offer') {
            return rejected(
              invalidState(`Cannot set a local offer in state ${s.signaling}.`),
            );
          }
          return then(
            ask((req) => call('rtcOffer', s.id, req, s.iceRestart)),
            (sdp: string) => {
              s.lastOffer = sdp;
              noteCreated(s, sdp);
              return setDescription(s, false, 'offer', sdp);
            },
          );
        }
        if (
          s.signaling !== 'have-remote-offer' &&
          s.signaling !== 'have-local-pranswer'
        ) {
          return rejected(
            invalidState(`Cannot set a local ${type} in state ${s.signaling}.`),
          );
        }
        return then(
          ask((req) => call('rtcAnswer', s.id, req)),
          (sdp: string) => {
            s.lastAnswer = sdp;
            noteCreated(s, sdp);
            return setDescription(s, false, type, sdp);
          },
        );
      });
    }
    setRemoteDescription(description?: Any, b?: Any, c?: Any): Promise<void> {
      if (typeof b === 'function' || typeof c === 'function') {
        return legacy(this.setRemoteDescription(description), b, c);
      }
      let s: Any;
      let type: string;
      let sdp: string;
      try {
        s = slotOf(this, 'pc');
        if (
          description === undefined ||
          description === null ||
          typeof description !== 'object'
        ) {
          throw typeError(
            "Failed to execute 'setRemoteDescription': parameter 1 is not of type 'RTCSessionDescriptionInit'.",
          );
        }
        if (description.type === undefined) {
          throw typeError(
            "Failed to execute 'setRemoteDescription': required member type is undefined.",
          );
        }
        type = enumOf(description.type, SDP_TYPES, 'RTCSdpType');
        sdp = description.sdp === undefined ? '' : String(description.sdp);
      } catch (error) {
        return rejected(error);
      }
      return chain(s, () => {
        if (s.closed) return rejected(invalidState());
        if (type === 'offer' && s.signaling === 'have-local-offer') {
          // an offer that crosses the connection's own: the connection's
          // is rolled back first (perfect negotiation)
          return then(setDescription(s, false, 'rollback', ''), () =>
            setDescription(s, true, 'offer', sdp),
          );
        }
        return setDescription(s, true, type, type === 'rollback' ? '' : sdp);
      });
    }
    addIceCandidate(candidate?: Any, b?: Any, c?: Any): Promise<void> {
      if (typeof b === 'function' || typeof c === 'function') {
        return legacy(this.addIceCandidate(candidate), b, c);
      }
      let s: Any;
      let init: Any;
      try {
        s = slotOf(this, 'pc');
        init = iceInitOf(
          candidate instanceof RTCIceCandidate ? candidate.toJSON() : candidate,
        );
      } catch (error) {
        return rejected(error);
      }
      const text: string = init.candidate;
      const sdpMid: string | null = init.sdpMid;
      const index: number | null = init.sdpMLineIndex;
      const ufrag: string | null = init.usernameFragment;
      if (text !== '' && sdpMid === null && index === null) {
        return rejected(
          typeError('A candidate needs its sdpMid or its sdpMLineIndex.'),
        );
      }
      return chain(s, () => {
        if (s.closed) return rejected(invalidState());
        const d = descriptionsOf(s);
        const remoteSdp = d.pendingRemote ?? d.currentRemote;
        if (remoteSdp === null) {
          return rejected(
            invalidState(
              'There is no remote description to add a candidate to.',
            ),
          );
        }
        const sections = sectionsOf(remoteSdp);
        let section: SdpSection | undefined;
        if (sdpMid !== null) {
          section = sections.find((m) => m.mid === sdpMid);
          if (!section) {
            return rejected(
              domError(
                `There is no m-section with mid ${sdpMid}.`,
                'OperationError',
              ),
            );
          }
        } else if (index !== null) {
          section = sections[index];
          if (!section) {
            return rejected(
              domError(`There is no m-section ${index}.`, 'OperationError'),
            );
          }
        }
        if (
          ufrag !== null &&
          section &&
          section.ufrag !== null &&
          section.ufrag !== ufrag
        ) {
          return rejected(
            domError(
              'The username fragment is not the remote one.',
              'OperationError',
            ),
          );
        }
        if (text !== '' && !parseCandidate(text)) {
          return rejected(
            domError(`'${text}' is not a candidate.`, 'OperationError'),
          );
        }
        const payload =
          text === '' && sdpMid === null && index === null
            ? null
            : stringify({
                candidate: text,
                sdpMid,
                sdpMLineIndex: index,
                usernameFragment: ufrag,
              });
        return then(
          ask((req) => call('rtcCandidate', s.id, req, payload)),
          () => {
            if (text !== '' && section) {
              // a data m-section's is the SCTP transport's
              const used =
                s.transceivers
                  .map((x: Any) => apply(wmGet, slots, [x]))
                  .find((t: Any) => t.mid === section!.mid)?.transport ??
                (section.kind === 'application' ? s.sctpTransport : undefined);
              if (used !== undefined && used !== null) {
                apply(wmGet, slots, [transportOf(s, used).ice]).remote.push(
                  new RTCIceCandidate({
                    candidate: text,
                    sdpMid: section.mid ?? '0',
                    sdpMLineIndex: index,
                    usernameFragment: ufrag,
                  }),
                );
              }
            }
            return undefined;
          },
        );
      });
    }
    restartIce(): void {
      const s = slotOf(this, 'pc');
      if (s.closed) return;
      // [[LocalIceCredentialsToReplace]]: the credentials of the local
      // descriptions, which before the first is set are none, and asks for
      // no negotiation (WebRTC 1.0, 4.4.3.2)
      const d = descriptionsOf(s);
      s.iceCredentials = new Set([
        ...ufragsOf(d.currentLocal),
        ...ufragsOf(d.pendingLocal),
      ]);
      s.iceRestart = s.iceCredentials.size > 0;
      if (s.iceRestart) call('rtcRestartIce', s.id);
      updateNegotiationNeeded(s);
    }
    getConfiguration(): Any {
      const c = slotOf(this, 'pc').config;
      return {
        iceServers: c.servers.map((s: Any) => ({
          ...s.kept,
          urls:
            typeof s.kept.urls === 'string' ? s.kept.urls : s.kept.urls.slice(),
        })),
        iceTransportPolicy: c.iceTransportPolicy,
        bundlePolicy: c.bundlePolicy,
        rtcpMuxPolicy: c.rtcpMuxPolicy,
        iceCandidatePoolSize: c.iceCandidatePoolSize,
        certificates: c.certificates.slice(),
      };
    }
    setConfiguration(configuration?: Any): void {
      const s = slotOf(this, 'pc');
      if (s.closed) throw invalidState();
      const next = configurationOf(configuration);
      const before = s.config;
      if (
        configuration?.certificates !== undefined &&
        (next.certificates.length !== before.certificates.length ||
          next.certificates.some(
            (c: Any, i: number) => c !== before.certificates[i],
          ))
      ) {
        throw domError(
          'The certificates cannot be changed.',
          'InvalidModificationError',
        );
      }
      if (next.bundlePolicy !== before.bundlePolicy) {
        throw domError(
          'The bundle policy cannot be changed.',
          'InvalidModificationError',
        );
      }
      if (next.rtcpMuxPolicy !== before.rtcpMuxPolicy) {
        throw domError(
          'The RTCP mux policy cannot be changed.',
          'InvalidModificationError',
        );
      }
      if (
        next.iceCandidatePoolSize !== before.iceCandidatePoolSize &&
        s.everSetLocal
      ) {
        throw domError(
          'The candidate pool size cannot be changed once a local description is set.',
          'InvalidModificationError',
        );
      }
      next.certificates = before.certificates;
      s.config = next;
      call('rtcConfigure', s.id, requestOf(next));
    }
    close(): void {
      const s = slotOf(this, 'pc');
      if (s.closed) return;
      s.closed = true;
      s.signaling = 'closed';
      s.ops = [];
      for (const tx of s.transceivers) {
        stopTransceiver(apply(wmGet, slots, [tx]), true, true);
      }
      channels.closeAll(s);
      for (const t of s.transports.values()) {
        setTransportState(t, {
          ...t.state,
          iceState: 'closed',
          dtlsState: 'closed',
        });
      }
      call('rtcClose', s.id);
      connections.delete(s.id);
    }

    getSenders(): Any[] {
      return slotOf(this, 'pc')
        .transceivers.map((x: Any) => apply(wmGet, slots, [x]))
        .filter((t: Any) => !t.stopped)
        .map((t: Any) => t.sender);
    }
    getReceivers(): Any[] {
      return slotOf(this, 'pc')
        .transceivers.map((x: Any) => apply(wmGet, slots, [x]))
        .filter((t: Any) => !t.stopped)
        .map((t: Any) => t.receiver);
    }
    getTransceivers(): Any[] {
      return slotOf(this, 'pc').transceivers.slice();
    }
    addTransceiver(trackOrKind: Any, init?: Any): Any {
      const s = slotOf(this, 'pc');
      if (s.closed) throw invalidState();
      let kind: string;
      let track: Any = null;
      if (media.isTrack(trackOrKind)) {
        track = trackOrKind;
        kind = track.kind;
      } else {
        kind = String(trackOrKind);
        if (kind !== 'audio' && kind !== 'video') {
          throw typeError(
            `Failed to execute 'addTransceiver': The provided value '${kind}' is not a valid kind.`,
          );
        }
      }
      const i = dictionary(init, 'RTCRtpTransceiverInit');
      const direction = enumOf(
        i.direction,
        DIRECTIONS,
        'RTCRtpTransceiverDirection',
        'sendrecv',
      );
      const streams: Any[] = i.streams === undefined ? [] : [...i.streams];
      for (const stream of streams) {
        if (!media.isStream(stream)) {
          throw typeError(
            "Failed to execute 'addTransceiver': a stream is not a MediaStream.",
          );
        }
      }
      const encodings = encodingsOf(i.sendEncodings, kind);
      return addTransceiverOf(
        s,
        kind,
        direction,
        track,
        streams.map((x: Any) => x.id),
        encodings,
      );
    }
    addTrack(track: Any, ...streams: Any[]): Any {
      const s = slotOf(this, 'pc');
      if (!media.isTrack(track)) {
        throw typeError(
          "Failed to execute 'addTrack': parameter 1 is not of type 'MediaStreamTrack'.",
        );
      }
      for (const stream of streams) {
        if (!media.isStream(stream)) {
          throw typeError(
            "Failed to execute 'addTrack': a stream is not a MediaStream.",
          );
        }
      }
      if (s.closed) throw invalidState();
      const all = s.transceivers.map((x: Any) => apply(wmGet, slots, [x]));
      if (
        all.some(
          (t: Any) =>
            apply(wmGet, slots, [t.sender]).track === track && !t.stopped,
        )
      ) {
        throw domError(
          'The track is already sent by this connection.',
          'InvalidAccessError',
        );
      }
      const ids: string[] = [];
      for (const stream of streams)
        if (!ids.includes(stream.id)) ids.push(stream.id);
      // a transceiver that can carry it: of its kind, sending nothing, and
      // never negotiated to send
      const reused = all.find(
        (t: Any) =>
          t.kind === track.kind &&
          !t.stopping &&
          !t.sent &&
          apply(wmGet, slots, [t.sender]).track === null,
      );
      if (reused) {
        // a rollback of the remote offer that made it keeps it now
        reused.addTracked = true;
        const sender = apply(wmGet, slots, [reused.sender]);
        sender.track = track;
        sender.streams = ids;
        sendTrack(reused, track);
        call('rtcStreams', reused.id, stringify(ids));
        const direction =
          reused.direction === 'recvonly'
            ? 'sendrecv'
            : reused.direction === 'inactive'
              ? 'sendonly'
              : reused.direction;
        if (direction !== reused.direction) {
          reused.direction = direction;
          call('rtcDirection', reused.id, direction);
        }
        updateNegotiationNeeded(s);
        return reused.sender;
      }
      const t = addTransceiverOf(
        s,
        track.kind,
        'sendrecv',
        track,
        ids,
        encodingsOf([], track.kind),
      );
      return t.sender;
    }
    removeTrack(sender: Any): void {
      const s = slotOf(this, 'pc');
      if (!isA(sender, 'sender')) {
        throw typeError(
          "Failed to execute 'removeTrack': parameter 1 is not of type 'RTCRtpSender'.",
        );
      }
      if (s.closed) throw invalidState();
      const sl = apply(wmGet, slots, [sender]);
      if (sl.tx.pc !== s) {
        throw domError(
          'The sender is not this connection’s.',
          'InvalidAccessError',
        );
      }
      if (sl.tx.stopping || sl.track === null) return;
      sl.track = null;
      sendTrack(sl.tx, null);
      const t = sl.tx;
      const direction =
        t.direction === 'sendrecv'
          ? 'recvonly'
          : t.direction === 'sendonly'
            ? 'inactive'
            : t.direction;
      if (direction !== t.direction) {
        t.direction = direction;
        call('rtcDirection', t.id, direction);
      }
      updateNegotiationNeeded(s);
    }
    createDataChannel(label: Any, ...rest: Any[]): Any {
      const s = slotOf(this, 'pc');
      // the label is required, so an undefined one is "undefined"
      if (arguments.length < 1) {
        throw typeError(
          "Failed to execute 'createDataChannel' on 'RTCPeerConnection': 1 argument required, but only 0 present.",
        );
      }
      // converted before anything is checked, as Web IDL converts it
      const name = `${label}`;
      if (s.closed) throw invalidState();
      const channel = channels.create(s, name, rest[0]);
      if (!s.anyChannel) {
        s.anyChannel = true;
        updateNegotiationNeeded(s);
      }
      return channel;
    }
    getStats(selector?: Any): Promise<Any> {
      let s: Any;
      try {
        s = slotOf(this, 'pc');
      } catch (error) {
        return rejected(error);
      }
      if (selector === undefined || selector === null)
        return statsOf(s, null, 'sender');
      if (!media.isTrack(selector)) {
        return rejected(
          typeError(
            "Failed to execute 'getStats': parameter 1 is not of type 'MediaStreamTrack'.",
          ),
        );
      }
      const all = s.transceivers.map((x: Any) => apply(wmGet, slots, [x]));
      const bySender = all.filter(
        (t: Any) => apply(wmGet, slots, [t.sender]).track === selector,
      );
      const byReceiver = all.filter(
        (t: Any) => apply(wmGet, slots, [t.receiver]).track === selector,
      );
      if (bySender.length + byReceiver.length !== 1) {
        return rejected(
          domError(
            'The track is not sent or received by exactly one of this connection’s transceivers.',
            'InvalidAccessError',
          ),
        );
      }
      return bySender.length
        ? statsOf(s, bySender[0], 'sender')
        : statsOf(s, byReceiver[0], 'receiver');
    }
  }
  for (const name of [
    'negotiationneeded',
    'icecandidate',
    'icecandidateerror',
    'signalingstatechange',
    'iceconnectionstatechange',
    'icegatheringstatechange',
    'connectionstatechange',
    'track',
    'datachannel',
  ]) {
    handler(RTCPeerConnection.prototype, name);
  }

  const addTransceiverOf = (
    s: Any,
    kind: string,
    direction: string,
    track: Any,
    streams: string[],
    encodings: Any[],
  ): Any => {
    const text = call(
      'rtcAddTransceiver',
      s.id,
      stringify({
        kind,
        direction,
        source: track ? media.sourceOf(track) : -1,
        trackId: track ? track.id : null,
        output: track ? media.output(track) : 'ended',
        streams,
        sendEncodings: encodings,
      }),
    );
    const made = typeof text === 'string' ? parse(text) : { id: 0, source: -1 };
    const t = makeTransceiver(
      s,
      made.id,
      made.source,
      kind,
      direction,
      track,
      streams,
      encodings,
    );
    watchSent(apply(wmGet, slots, [t]), track);
    updateNegotiationNeeded(s);
    return t;
  };

  /** RTCOfferOptions' legacy members (WebRTC 1.0, 11.2): `offerToReceive…`
   *  makes a transceiver that receives, or stops one receiving. */
  const legacyOfferOptions = (s: Any, options: Any): void => {
    for (const kind of ['audio', 'video']) {
      const key =
        kind === 'audio' ? 'offerToReceiveAudio' : 'offerToReceiveVideo';
      const want = options[key];
      if (want === undefined) continue;
      const of = s.transceivers
        .map((x: Any) => apply(wmGet, slots, [x]))
        .filter((t: Any) => t.kind === kind && !t.stopping);
      if (want === false || want === 0) {
        for (const t of of) {
          const direction =
            t.direction === 'sendrecv'
              ? 'sendonly'
              : t.direction === 'recvonly'
                ? 'inactive'
                : t.direction;
          if (direction !== t.direction) {
            t.direction = direction;
            call('rtcDirection', t.id, direction);
          }
        }
      } else if (!of.some((t: Any) => receives(t.direction))) {
        const t = of.find(
          (x: Any) => x.direction === 'sendonly' || x.direction === 'inactive',
        );
        if (t) {
          t.direction = t.direction === 'sendonly' ? 'sendrecv' : 'recvonly';
          call('rtcDirection', t.id, t.direction);
        } else {
          addTransceiverOf(
            s,
            kind,
            'recvonly',
            null,
            [],
            encodingsOf([], kind),
          );
        }
      }
    }
  };

  /** A tone a DTMF sender played (WebRTC 1.0, 7.3). */
  class RTCDTMFToneChangeEvent extends Event {
    constructor(type: string, init: Any = {}) {
      const i = dictionary(init, 'RTCDTMFToneChangeEventInit');
      super(type, i);
      apply(wmSet, slots, [
        this,
        { toneEvent: true, tone: i.tone === undefined ? '' : String(i.tone) },
      ]);
    }
    get tone(): string {
      return slotOf(this, 'toneEvent').tone;
    }
  }

  const classes: Record<string, Any> = {
    RTCPeerConnection,
    RTCSessionDescription,
    RTCIceCandidate,
    RTCIceCandidatePair,
    RTCPeerConnectionIceEvent,
    RTCPeerConnectionIceErrorEvent,
    RTCTrackEvent,
    RTCRtpTransceiver,
    RTCRtpSender,
    RTCRtpReceiver,
    RTCIceTransport,
    RTCDtlsTransport,
    RTCCertificate,
    RTCStatsReport,
    RTCError,
    RTCErrorEvent,
    RTCDTMFSender,
    RTCDTMFToneChangeEvent,
  };
  idl(classes);
  return { ...classes, ...channels.interfaces };
}
