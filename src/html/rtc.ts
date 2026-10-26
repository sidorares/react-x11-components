// What a page's `RTCPeerConnection` is carried over: the seam `<Html
// scripts>` asks for a connection (`HtmlScripts.webRTC`), shaped as
// WebTransport's is (`./transport.ts`), so that a stand-in, a test's
// loopback and a real stack all answer it alike.
//
// **The page's realm owns WebRTC's semantics; this seam owns the protocol.**
// The realm keeps the operations chain, the signalling state, every argument
// check and the exception it throws, and the order events are told in. It
// also works out what WebRTC 1.0 defines in terms of state it already has:
//   - a connection's `iceConnectionState`, `connectionState` and
//     `iceGatheringState` from its transports';
//   - whether negotiation is needed, from its transceivers and the
//     descriptions;
//   - a `track` event, from what a description says a transceiver now
//     receives;
//   - `bufferedAmount`;
//   - when each DTMF tone goes.
// What reaches the seam is what no page could compute: an offer or an
// answer made, a description applied, candidates gathered, transports'
// states, a data channel's bytes, and the media its receivers receive.
//
// **Nothing is connected by construction.** The default (`NO_WEBRTC`) makes
// connections that take a configuration and transceivers, and rejects every
// operation that needs a stack with a `NotSupportedError`; it gathers no
// candidate and opens no socket. `HtmlNetwork.webRTC` is to be a real one,
// over the optional peer `werift` (docs/prd-webrtc.md).
//
// What the seam names:
//   - an object for what the host calls methods on: a connection, a
//     transceiver, a data channel, a media source;
//   - a number for what is only told of: a transport, a certificate.
// Everything else either way is plain data: SDP as text, a candidate as its
// attribute line, bytes as a `Uint8Array`. A proxy across a thread can
// carry all of it as it is.
//
// Light on purpose: `<Html>` reaches it whether or not a document runs
// scripts.

import { idleSource } from './media-devices.js';
import type { MediaSourceEvents, MediaSourceLike } from './media-devices.js';

/** A direction, as a transceiver and an m-section have one. */
export type RTCDirectionLike =
  'sendrecv' | 'sendonly' | 'recvonly' | 'inactive' | 'stopped';

/** What an encoding and a data channel are prioritized as. */
export type RTCPriorityLike = 'very-low' | 'low' | 'medium' | 'high';

/** One of the page's `iceServers`, its `urls` always a list. */
export interface RTCIceServerLike {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * What a page made, `new RTCPeerConnection(configuration)`, and what
 * `setConfiguration` changes it to: converted and checked as the
 * constructor converts and checks them.
 */
export interface RTCConnectRequest {
  /** The page's origin. */
  origin: string;
  iceServers: RTCIceServerLike[];
  iceTransportPolicy: 'all' | 'relay';
  bundlePolicy: 'balanced' | 'max-compat' | 'max-bundle';
  rtcpMuxPolicy: 'require';
  iceCandidatePoolSize: number;
  /** The certificates the page passed, as `generateCertificate` numbered
   *  them. None, and the connection makes its own. */
  certificates: number[];
}

/** A codec, as `RTCRtpCodec` has it: `mimeType` as a browser writes it,
 *  `audio/opus`. */
export interface RTCCodecLike {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
}

/** A codec a description negotiated, with its payload type. */
export interface RTCCodecParametersLike extends RTCCodecLike {
  payloadType: number;
}

/** A header extension a description negotiated. */
export interface RTCHeaderExtensionLike {
  uri: string;
  id: number;
  encrypted: boolean;
}

/** A header extension a transceiver offers, as
 *  `setHeaderExtensionsToNegotiate` takes it. */
export interface RTCHeaderExtensionChoice {
  uri: string;
  direction: RTCDirectionLike;
}

/** One of a sender's encodings: `RTCRtpEncodingParameters`. */
export interface RTCEncodingLike {
  rid?: string;
  active: boolean;
  maxBitrate?: number;
  maxFramerate?: number;
  scaleResolutionDownBy?: number;
  scalabilityMode?: string;
  priority: RTCPriorityLike;
  networkPriority: RTCPriorityLike;
  codec?: RTCCodecLike;
}

/** What `getParameters()` answers from, less its `transactionId`, which is
 *  the page's realm's. */
export interface RTCRtpParametersLike {
  codecs: RTCCodecParametersLike[];
  headerExtensions: RTCHeaderExtensionLike[];
  rtcp: { cname?: string; reducedSize: boolean };
  /** A sender's; a receiver's have none. */
  encodings?: RTCEncodingLike[];
}

/** What `RTCRtpSender.getCapabilities` and `RTCRtpReceiver.getCapabilities`
 *  answer. */
export interface RTCCapabilitiesLike {
  codecs: RTCCodecLike[];
  headerExtensions: { uri: string }[];
}

/** A candidate, as `RTCIceCandidateInit` has it: its `candidate` the
 *  attribute line the page's realm reads its fields from. */
export interface RTCCandidateLike {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

/** A contributing or a synchronization source a receiver heard in the last
 *  ten seconds (`RTCRtpSynchronizationSource`). */
export interface RTCRtpSourceLike {
  kind: 'synchronization' | 'contributing';
  source: number;
  /** When its last packet was delivered, on the page's time origin. */
  timestamp: number;
  rtpTimestamp: number;
  audioLevel?: number;
}

/** One stats object, as an `RTCStatsReport` holds it: its fields are the
 *  type's dictionary's. */
export interface RTCStatsLike {
  id: string;
  type: string;
  timestamp: number;
  [field: string]: unknown;
}

/** What a page asked a new transceiver to be: `addTransceiver`'s init, or
 *  what `addTrack` came to. */
export interface RTCTransceiverInit {
  kind: 'audio' | 'video';
  direction: Exclude<RTCDirectionLike, 'stopped'>;
  /** What its sender sends, or null. */
  source: MediaSourceLike | null;
  /** The id of the track it sends, which a description's `msid` names. */
  trackId: string | null;
  /** The ids of the streams that track is in. */
  streams: string[];
  sendEncodings: RTCEncodingLike[];
}

/** One transceiver of a connection. */
export interface RTCTransceiverLike {
  readonly kind: 'audio' | 'video';
  /** What its receiver receives: a source muted until media arrives. The
   *  same object for the transceiver's life, as `receiver.track` is. */
  readonly received: MediaSourceLike;
  /** What its sender sends, and the id of the track it is — `addTrack`,
   *  `replaceTrack`, `removeTrack`. */
  setTrack(source: MediaSourceLike | null, trackId: string | null): void;
  setDirection(direction: Exclude<RTCDirectionLike, 'stopped'>): void;
  /** The streams its sender's track is in (`setStreams`). */
  setStreams(ids: string[]): void;
  /** `setCodecPreferences`, already checked against the capabilities; an
   *  empty list is the default order. */
  setCodecPreferences(codecs: RTCCodecLike[]): void;
  setHeaderExtensionsToNegotiate(extensions: RTCHeaderExtensionChoice[]): void;
  /** `sender.setParameters`, already checked: settles once the encodings
   *  are applied. */
  setParameters(parameters: {
    encodings: RTCEncodingLike[];
    degradationPreference?: string;
  }): Promise<void>;
  /** `stop()`: it is stopped once the next negotiation takes it out. */
  stop(): void;
  /** What `getSynchronizationSources` and `getContributingSources` answer
   *  from. */
  sources(): RTCRtpSourceLike[];
  /** `receiver.jitterBufferTarget`, in milliseconds, or null for the
   *  stack's own. */
  setJitterBufferTarget(ms: number | null): void;
  /** Sends one DTMF tone as RFC 4733 events for `duration` ms: false where
   *  the negotiated codecs have no `telephone-event`. */
  sendTone(tone: string, duration: number): boolean;
  /** `sender.getStats()` and `receiver.getStats()`: the stats that side's
   *  selector reaches. */
  stats(side: 'sender' | 'receiver'): Promise<RTCStatsLike[]>;
}

/** A transceiver as a description left it. */
export interface RTCTransceiverState {
  transceiver: RTCTransceiverLike;
  mid: string | null;
  /** Its direction now: a remote offer's new m-section makes one
   *  `recvonly`. */
  direction: RTCDirectionLike;
  /** What the last answer negotiated it to, or null before one. */
  currentDirection: RTCDirectionLike | null;
  /** The direction the remote description's m-section has, as the remote
   *  wrote it, or null where it has none. */
  remoteDirection: RTCDirectionLike | null;
  /** Taken out by a negotiation, or rejected: port 0. */
  stopped: boolean;
  sender: { transport: number | null; parameters: RTCRtpParametersLike };
  receiver: {
    transport: number | null;
    parameters: RTCRtpParametersLike;
    /** The streams the remote description's `msid` puts its track in. */
    streams: string[];
  };
  /** What `getNegotiatedHeaderExtensions` answers. */
  headerExtensions: RTCHeaderExtensionChoice[];
}

/** What a session is once a description is applied: answered by
 *  `setLocalDescription` and `setRemoteDescription`. */
export interface RTCSessionState {
  /** In the session's order, which `getTransceivers()` keeps: one a
   *  remote offer added is an object the page's realm has not seen. */
  transceivers: RTCTransceiverState[];
  /** The SCTP transport, where a description negotiated data channels. */
  sctp: {
    transport: number;
    maxMessageSize: number;
    maxChannels: number | null;
  } | null;
}

/**
 * The descriptions as the stack holds them now: what
 * `localDescription` and its kin answer, the candidates gathered since
 * included.
 */
export interface RTCDescriptionsLike {
  currentLocal: string | null;
  pendingLocal: string | null;
  currentRemote: string | null;
  pendingRemote: string | null;
}

/** A transport's state, told whole whenever any of it changes. */
export interface RTCTransportStateLike {
  iceState:
    | 'new'
    | 'checking'
    | 'connected'
    | 'completed'
    | 'disconnected'
    | 'failed'
    | 'closed';
  gatheringState: 'new' | 'gathering' | 'complete';
  role: 'controlling' | 'controlled' | 'unknown';
  dtlsState: 'new' | 'connecting' | 'connected' | 'closed' | 'failed';
  /** The remote's certificates, DER, once DTLS is connected. */
  remoteCertificates: Uint8Array[];
  /** The candidate pair in use, or null. */
  selectedPair: { local: RTCCandidateLike; remote: RTCCandidateLike } | null;
  localParameters: { usernameFragment: string; password: string } | null;
  remoteParameters: { usernameFragment: string; password: string } | null;
  /** Why DTLS failed, where it did: an `RTCError`'s detail. */
  error?: {
    errorDetail: 'dtls-failure' | 'fingerprint-failure';
    message: string;
    receivedAlert?: number;
    sentAlert?: number;
  };
}

/** What a page asked of a data channel, converted and checked as
 *  `createDataChannel` converts and checks it. */
export interface RTCDataChannelInitLike {
  label: string;
  ordered: boolean;
  maxPacketLifeTime: number | null;
  maxRetransmits: number | null;
  protocol: string;
  negotiated: boolean;
  /** Its stream id where the page chose one, or null. */
  id: number | null;
  priority: RTCPriorityLike;
}

/** What becomes of a data channel, told as it happens. */
export interface RTCDataChannelEvents {
  /** Its stream id, once the SCTP transport's roles are known. */
  id(id: number): void;
  open(): void;
  /** A message: a string where the peer sent one, bytes where it sent
   *  bytes. */
  message(data: string | Uint8Array): void;
  /** That many bytes of what was sent left the buffer. */
  sent(bytes: number): void;
  closing(): void;
  /** Told once, and nothing after it. */
  closed(): void;
  error(error: {
    errorDetail: 'data-channel-failure' | 'sctp-failure';
    sctpCauseCode: number | null;
    message: string;
  }): void;
}

/** One data channel of a connection, either side's. */
export interface RTCDataChannelLike {
  /** Starts telling its events; what happened before is kept. */
  listen(events: RTCDataChannelEvents): void;
  /** Sends a message, already checked against the transport's
   *  `maxMessageSize`. */
  send(data: string | Uint8Array): void;
  close(): void;
}

/** What becomes of a connection, told as it happens. */
export interface RTCConnectionEvents {
  /** A local candidate was gathered on a transport, and the local
   *  description holds it. */
  candidate(transport: number, candidate: RTCCandidateLike): void;
  /** A STUN or TURN server could not be used (`icecandidateerror`). */
  candidateError(error: {
    address: string | null;
    port: number | null;
    url: string;
    errorCode: number;
    errorText: string;
  }): void;
  /** A transport's state changed: the whole of it. */
  transport(transport: number, state: RTCTransportStateLike): void;
  /** The SCTP transport's state changed. */
  sctp(state: {
    transport: number;
    state: 'connecting' | 'connected' | 'closed';
    maxMessageSize: number;
    maxChannels: number | null;
  }): void;
  /** The peer opened a data channel. */
  dataChannel(
    channel: RTCDataChannelLike,
    init: RTCDataChannelInitLike & { id: number },
  ): void;
}

/**
 * One peer connection. Its operations are asked in the order the page's
 * operations chain runs them, one at a time. What one rejects with is an
 * error named as WebRTC names it (`rtcError`).
 */
export interface RTCConnectionLike {
  addTransceiver(init: RTCTransceiverInit): RTCTransceiverLike;
  /** An offer's SDP. */
  createOffer(options: { iceRestart: boolean }): Promise<string>;
  /** An answer's SDP, to the pending remote offer. */
  createAnswer(): Promise<string>;
  /** Applies a local description, or rolls one back (`sdp` then ''). */
  setLocalDescription(
    type: 'offer' | 'answer' | 'pranswer' | 'rollback',
    sdp: string,
  ): Promise<RTCSessionState>;
  /** Applies a remote description, or rolls one back (`sdp` then ''). */
  setRemoteDescription(
    type: 'offer' | 'answer' | 'pranswer' | 'rollback',
    sdp: string,
  ): Promise<RTCSessionState>;
  /** A remote candidate; one with a `candidate` of '' ends an m-section's,
   *  and null ends every one's. */
  addIceCandidate(candidate: RTCCandidateLike | null): Promise<void>;
  /** The next offer restarts ICE. */
  restartIce(): void;
  /** The page changed what it may change of its configuration. */
  setConfiguration(request: RTCConnectRequest): void;
  descriptions(): RTCDescriptionsLike;
  createDataChannel(init: RTCDataChannelInitLike): RTCDataChannelLike;
  /** `getStats()`: every stats object of the connection. */
  stats(): Promise<RTCStatsLike[]>;
  /** Closes it: nothing is told after it. */
  close(): void;
}

/** What `generateCertificate` was asked for, as WebCrypto names it. */
export type RTCKeygenLike =
  | { name: 'ECDSA'; namedCurve: 'P-256' }
  | {
      name: 'RSASSA-PKCS1-v1_5';
      modulusLength: number;
      publicExponent: number;
      hash: 'SHA-256';
    };

/** A certificate `generateCertificate` made. */
export interface RTCCertificateLike {
  /** What `RTCConnectRequest.certificates` names it by. */
  id: number;
  /** When it expires, in milliseconds since the epoch. */
  expires: number;
  fingerprints: { algorithm: string; value: string }[];
}

/**
 * What a page's `RTCPeerConnection` is carried over (`HtmlScripts.webRTC`).
 * `connect` never throws: what becomes of the connection is told through
 * `events`.
 */
export interface HtmlWebRTC {
  connect(
    request: RTCConnectRequest,
    events: RTCConnectionEvents,
  ): RTCConnectionLike;
  /** `RTCPeerConnection.generateCertificate`. */
  generateCertificate(
    keygen: RTCKeygenLike,
    expires: number,
  ): Promise<RTCCertificateLike>;
  /**
   * What a kind's sender or receiver can do, answered at once from what
   * the stack is configured with — before the stack itself is loaded, since
   * `getCapabilities` is synchronous. Null for a kind it has none of.
   */
  capabilities(
    kind: 'audio' | 'video',
    side: 'sender' | 'receiver',
  ): RTCCapabilitiesLike | null;
}

/** The names a WebRTC seam rejects with: a `DOMException`'s, or
 *  `RTCError`. */
export type RTCErrorName =
  | 'InvalidAccessError'
  | 'InvalidModificationError'
  | 'InvalidStateError'
  | 'NotSupportedError'
  | 'OperationError'
  | 'SyntaxError'
  | 'RTCError';

/** An `RTCError`'s detail (`RTCErrorInit`), where a seam has one. */
export interface RTCErrorDetailLike {
  errorDetail: string;
  sdpLineNumber?: number;
  sctpCauseCode?: number;
  receivedAlert?: number;
  sentAlert?: number;
}

/** An error a WebRTC seam rejects with: its `name` the one the page's
 *  error takes, and an `RTCError`'s detail beside it. */
export function rtcError(
  name: RTCErrorName,
  message: string,
  detail?: RTCErrorDetailLike,
): Error & { name: RTCErrorName; detail?: RTCErrorDetailLike } {
  const error = new Error(message) as Error & {
    name: RTCErrorName;
    detail?: RTCErrorDetailLike;
  };
  error.name = name;
  if (detail) error.detail = detail;
  return error;
}

const unsupported = (what: string) =>
  Promise.reject(
    rtcError(
      'NotSupportedError',
      `${what} needs a WebRTC stack: this <Html> has no scripts.webRTC.`,
    ),
  );

/** A transceiver no stack carries: it takes what the page sets, and its
 *  receiver receives nothing. */
function standInTransceiver(kind: 'audio' | 'video'): RTCTransceiverLike {
  return {
    kind,
    received: idleSource(kind),
    setTrack() {},
    setDirection() {},
    setStreams() {},
    setCodecPreferences() {},
    setHeaderExtensionsToNegotiate() {},
    setParameters: () => Promise.resolve(),
    stop() {},
    sources: () => [],
    setJitterBufferTarget() {},
    sendTone: () => false,
    stats: () => Promise.resolve([]),
  };
}

/** A data channel no stack carries: it never opens. */
const NO_CHANNEL: RTCDataChannelLike = {
  listen() {},
  send() {},
  close() {},
};

const NO_DESCRIPTIONS: RTCDescriptionsLike = {
  currentLocal: null,
  pendingLocal: null,
  currentRemote: null,
  pendingRemote: null,
};

/**
 * The default `webRTC`: no stack. A connection is made, configured and
 * given transceivers and data channels as the page asks, and every
 * operation that needs a stack rejects with a `NotSupportedError` naming
 * the missing seam; nothing is gathered, nothing is sent anywhere, and
 * `getCapabilities` answers null.
 */
export const NO_WEBRTC: HtmlWebRTC = {
  connect: () => ({
    addTransceiver: (init) => standInTransceiver(init.kind),
    createOffer: () => unsupported('createOffer()'),
    createAnswer: () => unsupported('createAnswer()'),
    setLocalDescription: () => unsupported('setLocalDescription()'),
    setRemoteDescription: () => unsupported('setRemoteDescription()'),
    addIceCandidate: () => unsupported('addIceCandidate()'),
    restartIce() {},
    setConfiguration() {},
    descriptions: () => NO_DESCRIPTIONS,
    createDataChannel: () => NO_CHANNEL,
    stats: () => Promise.resolve([]),
    close() {},
  }),
  generateCertificate: () => unsupported('generateCertificate()'),
  capabilities: () => null,
};

/** A source whose frames come from another, once there is one: what a
 *  receiver's track listens to before the stack that receives is loaded. */
function forwardingSource(kind: 'audio' | 'video'): MediaSourceLike & {
  attach(source: MediaSourceLike): void;
} {
  let real: MediaSourceLike | null = null;
  let listener: MediaSourceEvents | null = null;
  let stopped = false;
  return {
    kind,
    label: '',
    listen(events) {
      listener = events;
      if (real) real.listen(events);
      else events.muted(true);
    },
    settings: () => (real ? real.settings() : {}),
    capabilities: () => (real ? real.capabilities() : {}),
    reconfigure: (settings) =>
      real ? real.reconfigure(settings) : Promise.resolve(false),
    stop() {
      stopped = true;
      real?.stop();
    },
    attach(source) {
      real = source;
      if (stopped) source.stop();
      else if (listener) source.listen(listener);
    },
  };
}

/** A transceiver of a connection not made yet: what is asked of it is
 *  done, in order, once there is one. */
class DeferredTransceiver implements RTCTransceiverLike {
  readonly received: MediaSourceLike & { attach(s: MediaSourceLike): void };
  real: RTCTransceiverLike | null = null;
  private _queue: ((t: RTCTransceiverLike) => void)[] = [];

  constructor(readonly kind: 'audio' | 'video') {
    this.received = forwardingSource(kind);
  }

  attach(real: RTCTransceiverLike): void {
    this.real = real;
    this.received.attach(real.received);
    for (const run of this._queue.splice(0)) run(real);
  }

  private _do(run: (t: RTCTransceiverLike) => void): void {
    if (this.real) run(this.real);
    else this._queue.push(run);
  }

  setTrack(source: MediaSourceLike | null, trackId: string | null): void {
    this._do((t) => t.setTrack(source, trackId));
  }
  setDirection(direction: Exclude<RTCDirectionLike, 'stopped'>): void {
    this._do((t) => t.setDirection(direction));
  }
  setStreams(ids: string[]): void {
    this._do((t) => t.setStreams(ids));
  }
  setCodecPreferences(codecs: RTCCodecLike[]): void {
    this._do((t) => t.setCodecPreferences(codecs));
  }
  setHeaderExtensionsToNegotiate(extensions: RTCHeaderExtensionChoice[]): void {
    this._do((t) => t.setHeaderExtensionsToNegotiate(extensions));
  }
  setParameters(parameters: {
    encodings: RTCEncodingLike[];
    degradationPreference?: string;
  }): Promise<void> {
    return new Promise((resolve, reject) =>
      this._do((t) => t.setParameters(parameters).then(resolve, reject)),
    );
  }
  stop(): void {
    this._do((t) => t.stop());
  }
  sources(): RTCRtpSourceLike[] {
    return this.real ? this.real.sources() : [];
  }
  setJitterBufferTarget(ms: number | null): void {
    this._do((t) => t.setJitterBufferTarget(ms));
  }
  sendTone(tone: string, duration: number): boolean {
    return this.real ? this.real.sendTone(tone, duration) : false;
  }
  stats(side: 'sender' | 'receiver'): Promise<RTCStatsLike[]> {
    return new Promise((resolve, reject) =>
      this._do((t) => t.stats(side).then(resolve, reject)),
    );
  }
}

/** A data channel of a connection not made yet. */
class DeferredChannel implements RTCDataChannelLike {
  private _real: RTCDataChannelLike | null = null;
  private _queue: ((c: RTCDataChannelLike) => void)[] = [];

  attach(real: RTCDataChannelLike): void {
    this._real = real;
    for (const run of this._queue.splice(0)) run(real);
  }
  private _do(run: (c: RTCDataChannelLike) => void): void {
    if (this._real) run(this._real);
    else this._queue.push(run);
  }
  listen(events: RTCDataChannelEvents): void {
    this._do((c) => c.listen(events));
  }
  send(data: string | Uint8Array): void {
    this._do((c) => c.send(data));
  }
  close(): void {
    this._do((c) => c.close());
  }
}

/**
 * A connection over a seam not had yet — one loaded the first time a page
 * makes a connection — answered at once and carried over it once it is.
 * What the page asks of it meanwhile is done in the order it asked; an
 * operation waits for the seam. Its transceivers are its own objects, and so
 * are those the seam's answers name: one a remote offer made is wrapped as
 * it is first named.
 */
export function deferredConnection(
  seam: Promise<HtmlWebRTC>,
  request: RTCConnectRequest,
  events: RTCConnectionEvents,
): RTCConnectionLike {
  let real: RTCConnectionLike | null = null;
  let failure: Error | null = null;
  let closed = false;
  const queue: ((c: RTCConnectionLike) => void)[] = [];
  const wrappers = new Map<RTCTransceiverLike, DeferredTransceiver>();
  const wrap = (t: RTCTransceiverLike): DeferredTransceiver => {
    let w = wrappers.get(t);
    if (!w) {
      w = new DeferredTransceiver(t.kind);
      w.attach(t);
      wrappers.set(t, w);
    }
    return w;
  };
  const ready = seam.then(
    (s) => {
      real = s.connect(request, events);
      for (const run of queue.splice(0)) run(real);
      if (closed) real.close();
      return real;
    },
    (error: unknown) => {
      failure = rtcError(
        'OperationError',
        String((error as Error)?.message ?? error),
      );
      return null;
    },
  );
  const after = <T>(run: (c: RTCConnectionLike) => Promise<T>): Promise<T> =>
    ready.then((c) => (c ? run(c) : Promise.reject(failure)));
  const mapped = (state: RTCSessionState): RTCSessionState => ({
    ...state,
    transceivers: state.transceivers.map((t) => ({
      ...t,
      transceiver: wrap(t.transceiver),
    })),
  });
  const now = (run: (c: RTCConnectionLike) => void): void => {
    if (real) run(real);
    else queue.push(run);
  };
  return {
    addTransceiver(init) {
      const w = new DeferredTransceiver(init.kind);
      now((c) => {
        const t = c.addTransceiver(init);
        wrappers.set(t, w);
        w.attach(t);
      });
      return w;
    },
    createOffer: (options) => after((c) => c.createOffer(options)),
    createAnswer: () => after((c) => c.createAnswer()),
    setLocalDescription: (type, sdp) =>
      after((c) => c.setLocalDescription(type, sdp)).then(mapped),
    setRemoteDescription: (type, sdp) =>
      after((c) => c.setRemoteDescription(type, sdp)).then(mapped),
    addIceCandidate: (candidate) => after((c) => c.addIceCandidate(candidate)),
    restartIce: () => now((c) => c.restartIce()),
    setConfiguration: (next) => now((c) => c.setConfiguration(next)),
    descriptions: () => (real ? real.descriptions() : NO_DESCRIPTIONS),
    createDataChannel(init) {
      const w = new DeferredChannel();
      now((c) => w.attach(c.createDataChannel(init)));
      return w;
    },
    stats: () => after((c) => c.stats()),
    close() {
      closed = true;
      real?.close();
    },
  };
}
