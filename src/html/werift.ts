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
import { WeriftTransports } from './werift-transports.js';
import type {
  WCandidate,
  WChannel,
  WDtls,
  WEvent,
  WSctp,
} from './werift-transports.js';
import type {
  HtmlWebRTC,
  RTCCandidateLike,
  RTCCodecLike,
  RTCCodecParametersLike,
  RTCConnectRequest,
  RTCConnectionEvents,
  RTCConnectionLike,
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
} from './rtc.js';

// --- werift's shape, the slice read here ------------------------------------

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
  /** Whether a description applied gave it an m-section. */
  readonly associated?: boolean;
  readonly codecs: WCodec[];
  readonly headerExtensions: WExtension[];
  readonly sender: WSender;
  readonly dtlsTransport?: WDtls;
  setDirection(direction: string): void;
  setCodecPreferences(codecs: WCodec[]): void;
  stop(): void;
}

interface WDescription {
  type: string;
  sdp: string;
}

interface WPeer {
  readonly signalingState: string;
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

/** The media kinds werift reads; another's m-section is rejected. */
const KNOWN_KINDS = new Set(['audio', 'video', 'application']);
/** What an unknown kind's m-section is handed to werift as: an audio one
 *  rejected, port 0, which werift answers rejected and makes nothing of. */
const STAND_IN = 'm=audio 0 UDP/TLS/RTP/SAVPF 0';

/**
 * A description with each m-section of a kind werift does not read
 * (JSEP 5.3.1: rejected with port 0 in the answer) in the stand-in's
 * place, and the m-lines it took the place of, by mid.
 */
function standInUnknown(sdp: string): {
  sdp: string;
  lines: Map<string, string>;
} {
  const lines = new Map<string, string>();
  const parts = sdp.split(/(?=\r\nm=)/);
  for (let i = 1; i < parts.length; i++) {
    const mline = /^\r\n(m=(\S+)[^\r\n]*)/.exec(parts[i]);
    if (!mline || KNOWN_KINDS.has(mline[2])) continue;
    const mid = /\r\na=mid:(\S+)/.exec(parts[i])?.[1];
    if (!mid) continue;
    lines.set(mid, mline[1]);
    parts[i] = '\r\n' + STAND_IN + parts[i].slice(2 + mline[1].length);
  }
  return { sdp: parts.join(''), lines };
}

/** A description with each stand-in for a kind werift does not read put
 *  back as its own kind, rejected: port 0. */
function restoreUnknown(sdp: string, lines: Map<string, string>): string {
  if (!lines.size) return sdp;
  const parts = sdp.split(/(?=\r\nm=)/);
  for (let i = 1; i < parts.length; i++) {
    const mid = /\r\na=mid:(\S+)/.exec(parts[i])?.[1];
    const line = mid ? lines.get(mid) : undefined;
    const mline = /^\r\n(m=[^\r\n]*)/.exec(parts[i]);
    if (!line || !mline) continue;
    const [head, , proto, ...formats] = line.split(' ');
    const rejected = [head, '0', proto, ...formats].join(' ');
    parts[i] = '\r\n' + rejected + parts[i].slice(2 + mline[1].length);
  }
  return parts.join('');
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

// --- a connection -----------------------------------------------------------

/** One of a connection's transceivers. */
class WeriftTransceiver implements RTCTransceiverLike {
  readonly kind: 'audio' | 'video';
  readonly received: MediaSourceLike;

  constructor(
    readonly t: WTransceiver,
    private readonly _w: WeriftModule,
    private readonly _codecs: WCodec[],
    /** Whether a negotiation is under way. */
    private readonly _session: { negotiating(): boolean },
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
  /**
   * `stop()`: werift's, but not while a negotiation is under way — an
   * offer made and not yet applied, or a description waiting for its
   * answer. werift brings up no transport for a transceiver stopping, so
   * one stopped mid-negotiation had its transport answer checks and never
   * connect, where a browser keeps it until a negotiation takes the
   * transceiver out. Meanwhile it sends and receives nothing (`inactive`),
   * and werift is told of the stop as the next offer or answer is made
   * (`flushStop`).
   */
  stop(): void {
    if (this._session.negotiating()) {
      this._stopWaiting = true;
      this.t.setDirection('inactive');
    } else this.t.stop();
  }
  private _stopWaiting = false;
  /** A stop that waited, made as an offer or an answer is made. */
  flushStop(): void {
    if (!this._stopWaiting) return;
    this._stopWaiting = false;
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
  /** Whether an offer was made since a description was last applied. */
  private _offered = false;
  /** Whether a negotiation is under way, which a transceiver's stop asks
   *  (`WeriftTransceiver.stop`). */
  private readonly _session = {
    negotiating: () => this._offered || this._pc.signalingState !== 'stable',
  };
  private readonly _net: WeriftTransports;
  /** The m-lines of the remote offer's m-sections of kinds werift does
   *  not read, by mid: rejected in the answer as their own kinds. */
  private _unknown = new Map<string, string>();
  /** What the last answer negotiated each transceiver to, read from the
   *  answer itself: werift sets none for one stopping, or `inactive`. */
  private readonly _negotiated = new WeakMap<WTransceiver, RTCDirectionLike>();
  private _closed = false;

  constructor(
    private readonly _w: WeriftModule,
    request: RTCConnectRequest,
    events: RTCConnectionEvents,
    certificates: Map<number, WCertificate>,
  ) {
    const config = configOf(request, _w, certificates);
    this._pc = new _w.RTCPeerConnection(config);
    const codecs = config.codecs as { audio: WCodec[]; video: WCodec[] };
    this._codecs = [...codecs.audio, ...codecs.video];
    this._net = new WeriftTransports(this._pc, events, () => this._closed);
  }

  private _watchTransports(): void {
    this._net.watch();
  }

  private _transportId(dtls: WDtls | undefined): number | null {
    return this._net.idOf(dtls);
  }

  private _tellTransports(): void {
    this._net.tell();
  }

  private _wrap(t: WTransceiver): WeriftTransceiver {
    let w = this._wrapped.get(t);
    if (!w) {
      w = new WeriftTransceiver(t, this._w, this._codecs, this._session);
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
      let text = sdp.replace(/\r?\n/g, '\r\n');
      if (type !== 'rollback') {
        // a kind werift does not read throws in its parser: it is handed a
        // rejected audio m-section in that one's place, and the answer
        // puts the kind back (`restoreUnknown`)
        const stood = standInUnknown(text);
        text = stood.sdp;
        if (side === 'remote' && type === 'offer') this._unknown = stood.lines;
      }
      const description = type === 'rollback' ? { type } : { type, sdp: text };
      if (side === 'local') await this._pc.setLocalDescription(description);
      else await this._pc.setRemoteDescription(description);
    } catch (error) {
      throw asRtcError(error);
    }
    this._watchTransports();
    this._tellTransports();
    if (type === 'answer' || type === 'pranswer')
      this._noteNegotiated(side, sdp);
    this._offered = false;
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
    for (const w of this._wrapped.values()) w.flushStop();
    try {
      const offer = (
        await this._pc.createOffer({ iceRestart: options.iceRestart })
      ).sdp;
      this._offered = true;
      return offer;
    } catch (error) {
      throw asRtcError(error);
    }
  }

  async createAnswer(): Promise<string> {
    for (const w of this._wrapped.values()) w.flushStop();
    try {
      return restoreUnknown((await this._pc.createAnswer()).sdp, this._unknown);
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
    const as = (d: WDescription | null | undefined): string | null =>
      d ? restoreUnknown(d.sdp, this._unknown) : null;
    return {
      currentLocal: as(pc.currentLocalDescription),
      pendingLocal: as(pc.pendingLocalDescription),
      currentRemote: as(pc.currentRemoteDescription),
      pendingRemote: as(pc.pendingRemoteDescription),
    };
  }

  createDataChannel(init: RTCDataChannelInitLike): RTCDataChannelLike {
    return this._net.channel(init);
  }

  stats(): Promise<RTCStatsLike[]> {
    return this._net.stats();
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
