// A page's peer connections over `werift`: ICE (with STUN and TURN), DTLS,
// SCTP data channels and SRTP, and the offer/answer state under them, all
// of it TypeScript, on the runtime's own `node:dgram` and `node:crypto` — so
// the same on Node and on Bun, and no native build for anyone.
// `HtmlNetwork.webRTC` is this (`./network.ts`), loaded the first time a
// page makes a connection. docs/prd-webrtc.md has why werift and not a
// native libwebrtc.
//
// It is an optional peer, as `quico` is: some 29 megabytes installed, which
// an app that shows no WebRTC page never wants, so it is never installed for
// anyone, and an app that wants a page's connections installs it. It is
// reached by a dynamic `import()` whose specifier the compiler cannot see,
// and its types are written out here, structurally, so an app without it
// type-checks. Not installed, a connection is made and every operation that
// needs it rejects, as with no network.
//
// **The page's realm owns WebRTC's semantics** (`./rtc.ts`), so what is
// corrected here is what werift says about the protocol, and nothing of the
// API's: the codecs and header extensions a browser offers
// (`./rtc-codecs.ts`), SDP that is not SDP refused as a browser refuses it,
// and the parameters a description negotiated, which werift's
// `getParameters()` leaves out. docs/prd-webrtc.md has the list of where
// werift differs from a browser, and which side corrects each.

import { idleSource } from './media-devices.js';
import type { MediaSourceLike } from './media-devices.js';
import {
  OFFERED_CODECS,
  OFFERED_EXTENSIONS,
  offeredCapabilities,
} from './rtc-codecs.js';
import { rtcError } from './rtc.js';
import type {
  HtmlWebRTC,
  RTCCandidateLike,
  RTCCodecLike,
  RTCCodecParametersLike,
  RTCConnectRequest,
  RTCConnectionEvents,
  RTCConnectionLike,
  RTCDataChannelEvents,
  RTCDataChannelInitLike,
  RTCDataChannelLike,
  RTCDescriptionsLike,
  RTCDirectionLike,
  RTCHeaderExtensionLike,
  RTCRtpParametersLike,
  RTCSessionState,
  RTCStatsLike,
  RTCTransceiverInit,
  RTCTransceiverLike,
  RTCTransceiverState,
  RTCTransportStateLike,
} from './rtc.js';

declare const queueMicrotask: (fn: () => void) => void;
declare const Buffer: {
  from(bytes: Uint8Array): Uint8Array;
};

// --- werift's shape, the slice read here ------------------------------------

interface WEvent<A extends unknown[]> {
  subscribe(fn: (...args: A) => void): unknown;
}

interface WCodec {
  payloadType?: number;
  mimeType: string;
  clockRate: number;
  channels?: number;
  parameters?: string;
}

interface WExtension {
  id: number;
  uri: string;
}

interface WCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface WIce {
  readonly state: string;
  readonly role: string;
  readonly gatheringState: string;
  readonly onStateChange: WEvent<[string]>;
  getSelectedCandidatePair(): { local: WCandidate; remote: WCandidate } | null;
  getLocalParameters(): { usernameFragment: string; password: string };
  getRemoteParameters(): { usernameFragment: string; password: string } | null;
}

interface WDtls {
  readonly state: string;
  readonly iceTransport: WIce;
  readonly onStateChange: WEvent<[string]>;
}

interface WSctp {
  readonly dtlsTransport?: WDtls;
}

interface WSender {
  setStreams(streams: unknown[]): void;
  replaceTrack(track: unknown | null): Promise<void>;
}

interface WTransceiver {
  readonly kind: 'audio' | 'video';
  readonly mid: string | null;
  readonly direction: string;
  readonly currentDirection: string | null;
  readonly stopped: boolean;
  readonly stopping: boolean;
  /** Its m-section rejected by the remote, or to be in this negotiation. */
  readonly rejected?: boolean;
  readonly pendingRejection?: boolean;
  readonly codecs: WCodec[];
  readonly headerExtensions: WExtension[];
  readonly sender: WSender;
  readonly dtlsTransport?: WDtls;
  setDirection(direction: string): void;
  setCodecPreferences(codecs: WCodec[]): void;
  stop(): void;
}

interface WChannel {
  readonly id?: number | null;
  readonly readyState: string;
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readonly protocol: string;
  readonly negotiated: boolean;
  readonly stateChanged: WEvent<[string]>;
  readonly onMessage: WEvent<[string | Uint8Array]>;
  readonly error: WEvent<[Error]>;
  send(data: string | Uint8Array): void;
  close(): void;
}

interface WDescription {
  type: string;
  sdp: string;
}

interface WPeer {
  readonly cname: string;
  readonly onIceCandidate: WEvent<[WCandidate | undefined]>;
  readonly onDataChannel: WEvent<[WChannel]>;
  readonly iceGatheringStateChange: WEvent<[string]>;
  readonly iceConnectionStateChange: WEvent<[string]>;
  readonly connectionStateChange: WEvent<[string]>;
  readonly dtlsTransports: WDtls[];
  readonly sctpTransport?: WSctp;
  readonly currentLocalDescription: WDescription | null;
  readonly pendingLocalDescription: WDescription | null;
  readonly currentRemoteDescription: WDescription | null;
  readonly pendingRemoteDescription: WDescription | null;
  readonly remoteDescription: WDescription | null;
  getTransceivers(): WTransceiver[];
  addTransceiver(
    trackOrKind: unknown,
    options: Record<string, unknown>,
  ): WTransceiver;
  createOffer(options?: { iceRestart?: boolean }): Promise<WDescription>;
  createAnswer(): Promise<WDescription>;
  setLocalDescription(description: {
    type: string;
    sdp?: string;
  }): Promise<unknown>;
  setRemoteDescription(description: {
    type: string;
    sdp?: string;
  }): Promise<unknown>;
  addIceCandidate(candidate: WCandidate | null): Promise<void>;
  restartIce(): void;
  setConfiguration(config: Record<string, unknown>): void;
  createDataChannel(label: string, options: Record<string, unknown>): WChannel;
  getStats(): Promise<{ values(): Iterable<Record<string, unknown>> }>;
  close(): Promise<void>;
}

interface WCertificate {
  getFingerprints(): { algorithm: string; value: string }[];
}

interface WeriftModule {
  RTCPeerConnection: new (config: Record<string, unknown>) => WPeer;
  RTCCertificate: new (
    keyPem: string,
    certPem: string,
    signatureHash: unknown,
  ) => WCertificate;
  createSelfSignedCertificate(
    signatureHash: { hash: number; signature: number },
    namedCurve?: number,
  ): Promise<{ certPem: string; keyPem: string; signatureHash: unknown }>;
  HashAlgorithm: { sha256_4: number };
  SignatureAlgorithm: { rsa_1: number; ecdsa_3: number };
  NamedCurveAlgorithm: { secp256r1_23: number };
  RTCRtpCodecParameters: new (props: Record<string, unknown>) => WCodec;
  RTCRtpHeaderExtensionParameters: new (props: {
    id: number;
    uri: string;
  }) => WExtension;
  MediaStream: new (props: { id: string }) => unknown;
  MediaStreamTrack: new (props: { kind: string; id?: string }) => unknown;
}

/** Where werift is found: a variable, so no bundler follows it. */
const WERIFT_MODULE = 'werift';

let loading: Promise<WeriftModule | null> | null = null;

/** werift, where it is installed, or null. */
export function loadWerift(): Promise<WeriftModule | null> {
  if (!loading) {
    const specifier = WERIFT_MODULE;
    loading = (import(/* @vite-ignore */ specifier) as Promise<WeriftModule>)
      .then((m) => (typeof m?.RTCPeerConnection === 'function' ? m : null))
      .catch(() => null);
  }
  return loading;
}

// --- SDP, read as far as a description's state needs ------------------------

const DIRECTIONS = new Set(['sendrecv', 'sendonly', 'recvonly', 'inactive']);

/** A direction as the other side has it. */
function turned(direction: RTCDirectionLike): RTCDirectionLike {
  return direction === 'sendonly'
    ? 'recvonly'
    : direction === 'recvonly'
      ? 'sendonly'
      : direction;
}

/** One m-section of a description, as far as is read here. */
interface Section {
  direction: RTCDirectionLike;
  /** The streams its `msid` lines name. */
  streams: string[];
  maxMessageSize: number | null;
}

/** A description's m-sections, by their mid. */
function sectionsOf(sdp: string): Map<string, Section> {
  const out = new Map<string, Section>();
  let session: RTCDirectionLike = 'sendrecv';
  let current: (Section & { mid: string | null; port: number }) | null = null;
  const close = () => {
    if (current?.mid != null) {
      out.set(current.mid, {
        direction: current.port === 0 ? 'inactive' : current.direction,
        streams: current.streams,
        maxMessageSize: current.maxMessageSize,
      });
    }
  };
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      close();
      current = {
        mid: null,
        port: Number(line.split(' ')[1]),
        direction: session,
        streams: [],
        maxMessageSize: null,
      };
    } else if (line.startsWith('a=')) {
      const attr = line.slice(2);
      const colon = attr.indexOf(':');
      const name = colon < 0 ? attr : attr.slice(0, colon);
      const value = colon < 0 ? '' : attr.slice(colon + 1);
      if (DIRECTIONS.has(name)) {
        if (current) current.direction = name as RTCDirectionLike;
        else session = name as RTCDirectionLike;
      } else if (current && name === 'mid') {
        current.mid = value;
      } else if (current && name === 'msid') {
        const stream = value.split(' ')[0];
        if (stream && stream !== '-' && !current.streams.includes(stream)) {
          current.streams.push(stream);
        }
      } else if (current && name === 'max-message-size') {
        current.maxMessageSize = Number(value);
      }
    }
  }
  close();
  return out;
}

/**
 * The first line of `sdp` that is not SDP (RFC 8866, 5: `<type>=<value>`,
 * the first `v=0`), counting from 1, or 0 where every line is. werift
 * applies a description it cannot read as an empty one, where a browser
 * refuses it as an `RTCError` of `sdp-syntax-error`.
 */
function syntaxErrorLine(sdp: string): number {
  const lines = sdp.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0 || lines[0] !== 'v=0') return 1;
  for (let i = 1; i < lines.length; i++) {
    if (!/^[a-z]=/.test(lines[i])) return i + 1;
  }
  return 0;
}

/**
 * Why a remote description's media is one a browser refuses, or null:
 * an RTP m-section with no `a=rtcp-mux`, which the only `rtcpMuxPolicy`
 * there is requires (WebRTC 1.0, 4.4.1.6), or with a payload type from 64
 * to 95, which RTCP's packet types collide with when they share a port
 * (RFC 5761, 4). werift applies both.
 */
function refusedMedia(sdp: string): string | null {
  const sections = sdp.split(/\r?\n(?=m=)/).slice(1);
  for (const section of sections) {
    const [kind, port, proto, ...formats] = section
      .split(/\r?\n/)[0]
      .slice(2)
      .split(' ');
    if (kind !== 'audio' && kind !== 'video') continue;
    if (Number(port) === 0 || !/RTP/.test(proto)) continue;
    if (!/^a=rtcp-mux\s*$/m.test(section)) {
      return `The ${kind} m-section does not multiplex RTCP, which rtcpMuxPolicy 'require' needs.`;
    }
    const clash = formats.find((f) => Number(f) >= 64 && Number(f) <= 95);
    if (clash !== undefined) {
      return `Payload type ${clash} collides with RTCP's packet types.`;
    }
  }
  return null;
}

/** Each m-section's header extensions, by its mid: id to URI. */
function extmapsOf(sdp: string): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  for (const section of sdp.split(/\r?\n(?=m=)/).slice(1)) {
    const mid = /^a=mid:(\S+)/m.exec(section)?.[1];
    if (!mid) continue;
    const ids = new Map<number, string>();
    for (const m of section.matchAll(/^a=extmap:(\d+)(?:\/\S+)?\s+(\S+)/gm)) {
      ids.set(Number(m[1]), m[2]);
    }
    out.set(mid, ids);
  }
  return out;
}

/**
 * Why a remote description gives a header extension negotiated before
 * another id, or an id another extension: what RFC 8285 forbids within a
 * session (JSEP 5.8 and 5.9), and a browser refuses as an
 * `InvalidAccessError`. Werift takes it.
 */
function reassignedExtension(sdp: string, before: string): string | null {
  const now = extmapsOf(sdp);
  for (const [mid, was] of extmapsOf(before)) {
    const ids = now.get(mid);
    if (!ids) continue;
    for (const [id, uri] of ids) {
      const old = was.get(id);
      if (old !== undefined && old !== uri) {
        return `Header extension id ${id} was ${old}, and may not become ${uri}.`;
      }
      for (const [oldId, oldUri] of was) {
        if (oldUri === uri && oldId !== id) {
          return `${uri} was id ${oldId}, and may not become ${id}.`;
        }
      }
    }
  }
  return null;
}

/** What werift threw, as the error the page's realm makes its own. */
function asRtcError(error: unknown): Error {
  const name = String((error as Error)?.name ?? '');
  const message = String((error as Error)?.message ?? error);
  return rtcError(
    name === 'InvalidStateError' ||
      name === 'InvalidAccessError' ||
      name === 'InvalidModificationError' ||
      name === 'NotSupportedError' ||
      name === 'SyntaxError'
      ? name
      : 'OperationError',
    message,
  );
}

const sameCodec = (a: RTCCodecLike, b: WCodec): boolean =>
  a.mimeType.toLowerCase() === b.mimeType.toLowerCase() &&
  a.clockRate === b.clockRate &&
  (a.channels ?? 1) === (b.channels ?? 1) &&
  (a.sdpFmtpLine ?? '') === (b.parameters ?? '');

/** A werift codec as a description's parameters name it. */
function codecOf(c: WCodec): RTCCodecParametersLike {
  return {
    payloadType: c.payloadType ?? 0,
    mimeType: c.mimeType,
    clockRate: c.clockRate,
    ...(c.channels !== undefined && c.mimeType.startsWith('audio/')
      ? { channels: c.channels }
      : {}),
    ...(c.parameters ? { sdpFmtpLine: c.parameters } : {}),
  };
}

function candidateOf(c: WCandidate): RTCCandidateLike {
  return {
    // a selected pair's candidates are written without their name
    candidate: c.candidate.startsWith('candidate:')
      ? c.candidate
      : `candidate:${c.candidate}`,
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
    usernameFragment: c.usernameFragment ?? null,
  };
}

// --- a connection -----------------------------------------------------------

/** One of a connection's transceivers. */
class WeriftTransceiver implements RTCTransceiverLike {
  readonly kind: 'audio' | 'video';
  readonly received: MediaSourceLike;

  constructor(
    readonly t: WTransceiver,
    private readonly _w: WeriftModule,
    private readonly _codecs: WCodec[],
  ) {
    this.kind = t.kind;
    this.received = idleSource(t.kind);
  }

  setTrack(source: MediaSourceLike | null, trackId: string | null): void {
    const track = source
      ? new this._w.MediaStreamTrack({
          kind: this.kind,
          ...(trackId ? { id: trackId } : {}),
        })
      : null;
    this.t.sender.replaceTrack(track).catch(() => {});
  }
  setDirection(direction: Exclude<RTCDirectionLike, 'stopped'>): void {
    this.t.setDirection(direction);
  }
  setStreams(ids: string[]): void {
    this.t.sender.setStreams(ids.map((id) => new this._w.MediaStream({ id })));
  }
  setCodecPreferences(codecs: RTCCodecLike[]): void {
    const chosen: WCodec[] = [];
    for (const codec of codecs) {
      const found = this._codecs.find((c) => sameCodec(codec, c));
      if (found && !chosen.includes(found)) chosen.push(found);
    }
    this.t.setCodecPreferences(chosen);
  }
  setHeaderExtensionsToNegotiate(): void {}
  setParameters(): Promise<void> {
    return Promise.resolve();
  }
  stop(): void {
    this.t.stop();
  }
  sources() {
    return [];
  }
  setJitterBufferTarget(): void {}
  sendTone(): boolean {
    return false;
  }
  stats(): Promise<RTCStatsLike[]> {
    return Promise.resolve([]);
  }
}

/** One of a connection's data channels. */
class WeriftChannel implements RTCDataChannelLike {
  private _events: RTCDataChannelEvents | null = null;
  private _told = 'connecting';
  private _idTold = false;

  constructor(private readonly _ch: WChannel) {
    _ch.stateChanged.subscribe((state) => this._state(state));
    _ch.onMessage.subscribe((data) => {
      this._events?.message(
        typeof data === 'string' ? data : new Uint8Array(data),
      );
    });
    _ch.error.subscribe((error) =>
      this._events?.error({
        errorDetail: 'data-channel-failure',
        sctpCauseCode: null,
        message: String(error?.message ?? error),
      }),
    );
  }

  private _state(state: string): void {
    const events = this._events;
    if (!events) return;
    if (!this._idTold && typeof this._ch.id === 'number') {
      this._idTold = true;
      events.id(this._ch.id);
    }
    if (state === this._told) return;
    // a channel told closed has been through closing, as the page's has
    if (state === 'closed' && this._told === 'open') events.closing();
    this._told = state;
    if (state === 'open') events.open();
    else if (state === 'closing') events.closing();
    else if (state === 'closed') events.closed();
  }

  listen(events: RTCDataChannelEvents): void {
    this._events = events;
    this._state(this._ch.readyState);
  }
  send(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? data : Buffer.from(data);
    this._ch.send(bytes);
    const size =
      typeof data === 'string'
        ? new TextEncoder().encode(data).byteLength
        : data.byteLength;
    queueMicrotask(() => this._events?.sent(size));
  }
  close(): void {
    this._ch.close();
  }
}

declare const TextEncoder: new () => { encode(text: string): Uint8Array };

/** The configuration werift is handed for a page's: its certificates
 *  those `generateCertificate` made, by their numbers. */
function configOf(
  request: RTCConnectRequest,
  w: WeriftModule,
  certificates: Map<number, WCertificate>,
): Record<string, unknown> {
  const chosen = request.certificates
    .map((id) => certificates.get(id))
    .filter((c): c is WCertificate => !!c);
  return {
    ...(chosen.length ? { certificates: chosen } : {}),
    iceServers: request.iceServers.map((s) => ({
      urls: s.urls,
      ...(s.username !== undefined ? { username: s.username } : {}),
      ...(s.credential !== undefined ? { credential: s.credential } : {}),
    })),
    iceTransportPolicy: request.iceTransportPolicy,
    bundlePolicy: request.bundlePolicy,
    // werift gathers no pool ahead of a description, and throws for one: a
    // pool is a hint (WebRTC 1.0, 4.2.5), so none is asked for
    iceCandidatePoolSize: 0,
    codecs: {
      audio: OFFERED_CODECS.audio.map((c) => codecFor(w, c)),
      video: OFFERED_CODECS.video.map((c) => codecFor(w, c)),
    },
    headerExtensions: {
      audio: OFFERED_EXTENSIONS.audio.map(
        (e) => new w.RTCRtpHeaderExtensionParameters(e),
      ),
      video: OFFERED_EXTENSIONS.video.map(
        (e) => new w.RTCRtpHeaderExtensionParameters(e),
      ),
    },
  };
}

function codecFor(
  w: WeriftModule,
  c: (typeof OFFERED_CODECS)['audio'][number],
): WCodec {
  return new w.RTCRtpCodecParameters({
    mimeType: c.mimeType,
    clockRate: c.clockRate,
    payloadType: c.payloadType,
    ...(c.channels !== undefined ? { channels: c.channels } : {}),
    ...(c.sdpFmtpLine ? { parameters: c.sdpFmtpLine } : {}),
    ...(c.rtcpFeedback ? { rtcpFeedback: c.rtcpFeedback } : {}),
  });
}

class WeriftConnection implements RTCConnectionLike {
  private readonly _pc: WPeer;
  private readonly _codecs: WCodec[];
  private readonly _wrapped = new Map<WTransceiver, WeriftTransceiver>();
  private readonly _transports = new Map<WDtls, number>();
  private readonly _told = new Map<number, string>();
  /** What the last answer negotiated each transceiver to, read from the
   *  answer itself: werift sets none for one stopping, or `inactive`. */
  private readonly _negotiated = new WeakMap<WTransceiver, RTCDirectionLike>();
  private _closed = false;

  constructor(
    private readonly _w: WeriftModule,
    request: RTCConnectRequest,
    private readonly _events: RTCConnectionEvents,
    certificates: Map<number, WCertificate>,
  ) {
    const config = configOf(request, _w, certificates);
    this._pc = new _w.RTCPeerConnection(config);
    const codecs = config.codecs as { audio: WCodec[]; video: WCodec[] };
    this._codecs = [...codecs.audio, ...codecs.video];
    const pc = this._pc;
    pc.onIceCandidate.subscribe((c) => {
      if (this._closed) return;
      this._watchTransports();
      // a transport is gathering before its first candidate is told, and
      // complete only after its last
      this._tellTransports();
      if (!c) return;
      const transport = this._transportOfMid(c.sdpMid ?? null);
      if (transport !== null) this._events.candidate(transport, candidateOf(c));
    });
    pc.onDataChannel.subscribe((ch) => {
      if (this._closed) return;
      this._events.dataChannel(new WeriftChannel(ch), {
        label: ch.label,
        ordered: ch.ordered,
        maxPacketLifeTime: ch.maxPacketLifeTime ?? null,
        maxRetransmits: ch.maxRetransmits ?? null,
        protocol: ch.protocol,
        negotiated: ch.negotiated,
        id: typeof ch.id === 'number' ? ch.id : 0,
        priority: 'low',
      });
    });
    const changed = () => {
      if (this._closed) return;
      this._watchTransports();
      this._tellTransports();
    };
    pc.iceGatheringStateChange.subscribe(changed);
    pc.iceConnectionStateChange.subscribe(changed);
    pc.connectionStateChange.subscribe(changed);
  }

  /** Each transport is numbered as it is first seen, and watched. */
  private _watchTransports(): void {
    for (const dtls of this._pc.dtlsTransports) {
      if (this._transports.has(dtls)) continue;
      this._transports.set(dtls, this._transports.size + 1);
      const changed = () => {
        if (!this._closed) this._tellTransports();
      };
      dtls.onStateChange.subscribe(changed);
      dtls.iceTransport.onStateChange.subscribe(changed);
    }
  }

  private _transportId(dtls: WDtls | undefined): number | null {
    if (!dtls) return null;
    this._watchTransports();
    return this._transports.get(dtls) ?? null;
  }

  private _transportOfMid(mid: string | null): number | null {
    const t = this._pc.getTransceivers().find((x) => x.mid === mid);
    const dtls =
      t?.dtlsTransport ??
      this._pc.sctpTransport?.dtlsTransport ??
      this._pc.dtlsTransports[0];
    return this._transportId(dtls);
  }

  private _snapshot(dtls: WDtls): RTCTransportStateLike {
    const ice = dtls.iceTransport;
    const pair = ice.getSelectedCandidatePair();
    let local = null;
    let remote = null;
    try {
      local = ice.getLocalParameters();
      remote = ice.getRemoteParameters();
    } catch {}
    return {
      // werift's controlled side is completed as soon as a pair is
      // nominated, where WebRTC 1.0's completed waits for the remote's end
      // of candidates as well, which werift never tells: connected
      iceState: (ice.state === 'completed'
        ? 'connected'
        : ice.state) as RTCTransportStateLike['iceState'],
      gatheringState:
        ice.gatheringState as RTCTransportStateLike['gatheringState'],
      role: ice.role as RTCTransportStateLike['role'],
      dtlsState: dtls.state as RTCTransportStateLike['dtlsState'],
      remoteCertificates: [],
      selectedPair: pair
        ? { local: candidateOf(pair.local), remote: candidateOf(pair.remote) }
        : null,
      localParameters: local
        ? { usernameFragment: local.usernameFragment, password: local.password }
        : null,
      remoteParameters: remote
        ? {
            usernameFragment: remote.usernameFragment,
            password: remote.password,
          }
        : null,
    };
  }

  /** Tells each transport whose state changed since it was last told. */
  private _tellTransports(): void {
    for (const [dtls, id] of this._transports) {
      const state = this._snapshot(dtls);
      const key = JSON.stringify(state);
      if (this._told.get(id) === key) continue;
      this._told.set(id, key);
      this._events.transport(id, state);
    }
  }

  private _wrap(t: WTransceiver): WeriftTransceiver {
    let w = this._wrapped.get(t);
    if (!w) {
      w = new WeriftTransceiver(t, this._w, this._codecs);
      this._wrapped.set(t, w);
    }
    return w;
  }

  /** The session as the descriptions applied left it. */
  private _state(): RTCSessionState {
    const remote = sectionsOf(this._pc.remoteDescription?.sdp ?? '');
    const transceivers: RTCTransceiverState[] = this._pc
      .getTransceivers()
      .map((t) => {
        const section = t.mid !== null ? remote.get(t.mid) : undefined;
        const transport = this._transportId(t.dtlsTransport);
        const parameters = (): RTCRtpParametersLike => ({
          codecs: section ? t.codecs.map(codecOf) : [],
          headerExtensions: section
            ? t.headerExtensions.map((e): RTCHeaderExtensionLike => ({
                uri: e.uri,
                id: e.id,
                encrypted: false,
              }))
            : [],
          rtcp: { cname: this._pc.cname, reducedSize: false },
        });
        const sends =
          section?.direction === 'sendrecv' ||
          section?.direction === 'sendonly';
        return {
          transceiver: this._wrap(t),
          mid: t.mid,
          direction: (t.stopping ||
          t.stopped ||
          t.rejected ||
          t.pendingRejection
            ? 'stopped'
            : t.direction) as RTCDirectionLike,
          // what the last answer as handed says, which is WebRTC 1.0's
          // definition, before werift's own: it has a transceiver stopping
          // since inactive, or none
          currentDirection: (this._negotiated.get(t) ??
            (t.currentDirection as RTCDirectionLike | null) ??
            null) as RTCDirectionLike | null,
          remoteDirection: section ? section.direction : null,
          stopped: t.stopped,
          sender: { transport, parameters: parameters() },
          receiver: {
            transport,
            parameters: parameters(),
            streams: sends ? section!.streams : [],
          },
          headerExtensions: section
            ? t.headerExtensions.map((e) => ({
                uri: e.uri,
                direction: 'sendrecv' as RTCDirectionLike,
              }))
            : [],
        };
      });
    const sctp = this._pc.sctpTransport;
    let maxMessageSize = 65536;
    for (const s of remote.values()) {
      if (s.maxMessageSize !== null)
        maxMessageSize = s.maxMessageSize || Infinity;
    }
    return {
      transceivers,
      sctp: sctp
        ? {
            transport: this._transportId(sctp.dtlsTransport) ?? 0,
            maxMessageSize,
            maxChannels: null,
          }
        : null,
    };
  }

  private async _apply(
    side: 'local' | 'remote',
    type: 'offer' | 'answer' | 'pranswer' | 'rollback',
    sdp: string,
  ): Promise<RTCSessionState> {
    if (type !== 'rollback') {
      const line = syntaxErrorLine(sdp);
      if (line) {
        throw rtcError(
          'RTCError',
          `Failed to parse the session description: line ${line} is not SDP.`,
          { errorDetail: 'sdp-syntax-error', sdpLineNumber: line },
        );
      }
      if (side === 'remote') {
        const refused =
          refusedMedia(sdp) ??
          reassignedExtension(
            sdp,
            this._pc.currentRemoteDescription?.sdp ?? '',
          );
        if (refused) throw rtcError('InvalidAccessError', refused);
      }
    }
    try {
      // a line may end in a bare LF, as a browser's parser takes it, and
      // werift's splits on CRLF alone: a description that mixes the two —
      // WPT writes its own so — ran its lines together
      const description =
        type === 'rollback'
          ? { type }
          : { type, sdp: sdp.replace(/\r?\n/g, '\r\n') };
      if (side === 'local') await this._pc.setLocalDescription(description);
      else await this._pc.setRemoteDescription(description);
    } catch (error) {
      throw asRtcError(error);
    }
    this._watchTransports();
    this._tellTransports();
    if (type === 'answer' || type === 'pranswer')
      this._noteNegotiated(side, sdp);
    return this._state();
  }

  /**
   * What an answer just applied negotiated each transceiver to, from this
   * side: the local answer's direction, or the remote answer's turned
   * round. A transceiver stopping goes on being negotiated until one takes
   * it out (WebRTC 1.0, 4.4.1.6), which werift does not do.
   */
  private _noteNegotiated(side: 'local' | 'remote', sdp: string): void {
    // the answer as it was handed: werift writes its own local description
    // again from what it has, a transceiver stopped since already inactive
    const sections = sectionsOf(sdp);
    for (const t of this._pc.getTransceivers()) {
      const section = t.mid !== null ? sections.get(t.mid) : undefined;
      if (!section) continue;
      this._negotiated.set(
        t,
        side === 'local' ? section.direction : turned(section.direction),
      );
    }
  }

  addTransceiver(init: RTCTransceiverInit): RTCTransceiverLike {
    const track = init.source
      ? new this._w.MediaStreamTrack({
          kind: init.kind,
          ...(init.trackId ? { id: init.trackId } : {}),
        })
      : null;
    const t = this._pc.addTransceiver(track ?? init.kind, {
      direction: init.direction,
      streams: init.streams.map((id) => new this._w.MediaStream({ id })),
      ...(init.sendEncodings.some((e) => e.rid)
        ? {
            sendEncodings: init.sendEncodings.map((e) => ({
              rid: e.rid,
              active: e.active,
            })),
          }
        : {}),
    });
    return this._wrap(t);
  }

  async createOffer(options: { iceRestart: boolean }): Promise<string> {
    try {
      return (await this._pc.createOffer({ iceRestart: options.iceRestart }))
        .sdp;
    } catch (error) {
      throw asRtcError(error);
    }
  }

  async createAnswer(): Promise<string> {
    try {
      return (await this._pc.createAnswer()).sdp;
    } catch (error) {
      throw asRtcError(error);
    }
  }

  setLocalDescription(
    type: 'offer' | 'answer' | 'pranswer' | 'rollback',
    sdp: string,
  ): Promise<RTCSessionState> {
    return this._apply('local', type, sdp);
  }

  setRemoteDescription(
    type: 'offer' | 'answer' | 'pranswer' | 'rollback',
    sdp: string,
  ): Promise<RTCSessionState> {
    return this._apply('remote', type, sdp);
  }

  async addIceCandidate(candidate: RTCCandidateLike | null): Promise<void> {
    try {
      await this._pc.addIceCandidate(
        candidate
          ? {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid ?? undefined,
              sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
              usernameFragment: candidate.usernameFragment ?? undefined,
            }
          : null,
      );
    } catch (error) {
      throw asRtcError(error);
    }
  }

  restartIce(): void {
    this._pc.restartIce();
  }

  setConfiguration(request: RTCConnectRequest): void {
    try {
      this._pc.setConfiguration({
        iceServers: request.iceServers,
        iceTransportPolicy: request.iceTransportPolicy,
      });
    } catch {}
  }

  descriptions(): RTCDescriptionsLike {
    const pc = this._pc;
    return {
      currentLocal: pc.currentLocalDescription?.sdp ?? null,
      pendingLocal: pc.pendingLocalDescription?.sdp ?? null,
      currentRemote: pc.currentRemoteDescription?.sdp ?? null,
      pendingRemote: pc.pendingRemoteDescription?.sdp ?? null,
    };
  }

  createDataChannel(init: RTCDataChannelInitLike): RTCDataChannelLike {
    const ch = this._pc.createDataChannel(init.label, {
      ordered: init.ordered,
      protocol: init.protocol,
      negotiated: init.negotiated,
      ...(init.maxPacketLifeTime !== null
        ? { maxPacketLifeTime: init.maxPacketLifeTime }
        : {}),
      ...(init.maxRetransmits !== null
        ? { maxRetransmits: init.maxRetransmits }
        : {}),
      ...(init.id !== null ? { id: init.id } : {}),
    });
    return new WeriftChannel(ch);
  }

  async stats(): Promise<RTCStatsLike[]> {
    const report = await this._pc.getStats();
    const out: RTCStatsLike[] = [];
    for (const s of report.values()) {
      out.push(JSON.parse(JSON.stringify(s)) as RTCStatsLike);
    }
    return out;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._pc.close().catch(() => {});
  }
}

/** A connection werift is not there to carry: every operation that needs
 *  it rejects. */
function unavailable(why: string): RTCConnectionLike {
  const no = () => Promise.reject(rtcError('NotSupportedError', why));
  return {
    addTransceiver: (init) => ({
      kind: init.kind,
      received: idleSource(init.kind),
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
    }),
    createOffer: no,
    createAnswer: no,
    setLocalDescription: no,
    setRemoteDescription: no,
    addIceCandidate: no,
    restartIce() {},
    setConfiguration() {},
    descriptions: () => ({
      currentLocal: null,
      pendingLocal: null,
      currentRemote: null,
      pendingRemote: null,
    }),
    createDataChannel: () => ({ listen() {}, send() {}, close() {} }),
    stats: () => Promise.resolve([]),
    close() {},
  };
}

/**
 * A page's peer connections over werift, where it is installed. Made once
 * werift has been looked for, so that `connect` is answered at once:
 * `HtmlNetwork.webRTC` waits for this and hands each connection over it
 * (`deferredConnection`).
 */
export async function weriftWebRTC(): Promise<HtmlWebRTC> {
  const w = await loadWerift();
  const certificates = new Map<number, WCertificate>();
  return {
    connect: (request, events) => {
      if (!w) {
        return unavailable(
          'werift is not installed, so no peer connection can be made.',
        );
      }
      try {
        return new WeriftConnection(w, request, events, certificates);
      } catch (error) {
        return unavailable(
          `werift could not make the connection: ${String((error as Error)?.message ?? error)}`,
        );
      }
    },
    async generateCertificate(keygen, expires) {
      if (!w) {
        throw rtcError(
          'NotSupportedError',
          'werift is not installed, so no certificate can be made.',
        );
      }
      const ecdsa = keygen.name === 'ECDSA';
      const made = await w.createSelfSignedCertificate(
        {
          hash: w.HashAlgorithm.sha256_4,
          signature: ecdsa
            ? w.SignatureAlgorithm.ecdsa_3
            : w.SignatureAlgorithm.rsa_1,
        },
        ecdsa ? w.NamedCurveAlgorithm.secp256r1_23 : undefined,
      );
      const certificate = new w.RTCCertificate(
        made.keyPem,
        made.certPem,
        made.signatureHash,
      );
      const id = certificates.size + 1;
      certificates.set(id, certificate);
      return {
        id,
        expires,
        fingerprints: certificate
          .getFingerprints()
          .map((f) => ({ algorithm: f.algorithm, value: f.value })),
      };
    },
    capabilities: (kind) => offeredCapabilities(kind),
  };
}
