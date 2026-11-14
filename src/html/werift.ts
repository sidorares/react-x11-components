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
import { unreachableServers } from './ice-servers.js';
import { rtcError } from './rtc.js';
import { MediaReceiver, MediaSender, hasMedia } from './werift-media.js';
import type {
  WMediaTrack,
  WMediaTransceiver,
  WeriftMediaModule,
} from './werift-media.js';
import { WeriftTransports } from './werift-transports.js';
import {
  asWeriftReads,
  keepPreferredCodecs,
  notePreferences,
  reofferCodecs,
} from './werift-codecs.js';
import type { WCodecLike } from './werift-codecs.js';
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
  RTCEncodedFrameLike,
  RTCEncodingLike,
  RTCHeaderExtensionChoice,
  RTCHeaderExtensionLike,
  RTCRtpParametersLike,
  RTCSessionState,
  RTCStatsLike,
  RTCTransceiverInit,
  RTCTransceiverLike,
  RTCTransceiverState,
  RTCTransformSide,
} from './rtc.js';

declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };

const MID_URI = 'urn:ietf:params:rtp-hdrext:sdes:mid';
const RID_URI = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';

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
  setSendEncodings?(encodings: { rid?: string; active?: boolean }[]): void;
  /** The rid werift writes into what it sends. */
  rtpStreamId?: string;
}

/** What of werift's sender says which codec it sends, which
 *  `setParameters` changes (`_chooseSendCodec`). */
interface WSendCodecs {
  readonly negotiatedCodecs?: WCodec[];
  codec?: WCodec;
  sendPrimaryCodec?: WCodec;
  rtxPayloadType?: number;
  readonly track?: { codec?: WCodec };
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
  /** The m-line's media kind. */
  kind: string;
  /** Rejected: port 0. */
  rejected: boolean;
  direction: RTCDirectionLike;
  /** The streams its `msid` lines name. */
  streams: string[];
  maxMessageSize: number | null;
}

/** A description's m-sections, by their mid. */
function sectionsOf(sdp: string): Map<string, Section> {
  const out = new Map<string, Section>();
  let session: RTCDirectionLike = 'sendrecv';
  let current:
    (Omit<Section, 'rejected'> & { mid: string | null; port: number }) | null =
    null;
  const close = () => {
    if (current?.mid != null) {
      out.set(current.mid, {
        kind: current.kind,
        rejected: current.port === 0,
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
        kind: line.slice(2).split(' ')[0],
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

/** What a browser writes for a track it sends in no stream: werift writes
 *  no `msid` at all, which a far side reads as the default stream (RFC
 *  8829, 5.10). werift never writes it bare. */
const NO_STREAM = 'a=msid:-';

/** A description with `a=msid:-` in each m-section werift sends a track in
 *  that names no stream, as a browser writes it. */
function namingNoStream(sdp: string): string {
  const parts = sdp.split(/(?=\r\nm=)/);
  for (let i = 1; i < parts.length; i++) {
    const mline = /^\r\nm=(audio|video) (\d+)/.exec(parts[i]);
    if (!mline || mline[2] === '0' || /\r\na=msid:/.test(parts[i])) continue;
    const direction =
      /\r\na=(sendrecv|sendonly|recvonly|inactive)(?=\r\n|$)/.exec(
        parts[i],
      )?.[1] ?? 'sendrecv';
    if (direction !== 'sendrecv' && direction !== 'sendonly') continue;
    const mid = /\r\na=mid:[^\r\n]*/.exec(parts[i]);
    parts[i] = mid
      ? parts[i].slice(0, mid.index + mid[0].length) +
        '\r\n' +
        NO_STREAM +
        parts[i].slice(mid.index + mid[0].length)
      : parts[i] + '\r\n' + NO_STREAM;
  }
  return parts.join('');
}

/** A local description as werift wrote it: `namingNoStream` taken back,
 *  since werift applies only the text it made. */
function withoutNoStream(sdp: string): string {
  return sdp.replace(/\r\na=msid:-(?=\r\n)/g, '');
}

/**
 * Whether a candidate attribute, with its `a=` or without, is one werift can
 * use: a UDP one. werift runs ICE-TCP (RFC 6544) only with `iceUseTcp`,
 * which is off by default and off here, so a TCP candidate pairs with none
 * of its local candidates. werift still took one as a remote candidate,
 * and the transport went to `checking` for a pair nothing could connect. A
 * browser that cannot use a candidate ignores it, so none reaches werift:
 * a TCP candidate aimed at a Fetch bad port changes nothing, as WPT's
 * `addTcpIceCandidate` has it.
 */
function overUdp(candidate: string): boolean {
  const fields = candidate.replace(/^a=/, '').split(' ');
  return (fields[2] ?? '').toLowerCase() === 'udp';
}

/** A description with the candidates werift cannot use taken out
 *  (`overUdp`). What werift keeps of it, which the page reads back, has
 *  none of them. */
function udpCandidatesOnly(sdp: string): string {
  return sdp.replace(/\r\na=candidate:[^\r\n]*/g, (line) =>
    overUdp(line.slice(2)) ? line : '',
  );
}

/** A description's first host candidate of an address family (any, for
 *  null): its address and port. */
function hostCandidateOf(
  sdp: string,
  family: 4 | 6 | null,
): { address: string; port: number } | null {
  for (const m of sdp.matchAll(
    /^a=candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ host/gim,
  )) {
    const [, address, port] = m;
    if (family === null || (family === 6) === address.includes(':')) {
      return { address, port: Number(port) };
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

// --- a connection -----------------------------------------------------------

/** What a transceiver's stats are asked of: the connection's. */
type StatsOf = (
  t: WeriftTransceiver,
  side: 'sender' | 'receiver',
) => Promise<RTCStatsLike[]>;

/** One of a connection's transceivers. */
class WeriftTransceiver implements RTCTransceiverLike {
  readonly kind: 'audio' | 'video';
  readonly received: MediaSourceLike;
  /** What sends its track's media, and what receives the peer's, where
   *  werift has the packetizers to (`./werift-media.ts`). */
  private readonly _send: MediaSender | null;
  private readonly _receive: MediaReceiver | null;
  /** Negotiated to send at some point: what an outbound-rtp's lifetime
   *  starts at (WebRTC Statistics, 3.2). */
  everSent = false;
  /** `stop()` was asked for, whether or not werift was told yet. */
  stopAsked = false;

  constructor(
    readonly t: WTransceiver,
    private readonly _w: WeriftModule,
    private readonly _codecs: WCodec[],
    /** Whether a negotiation is under way. */
    private readonly _session: { negotiating(): boolean },
    media: WeriftMediaModule | null = null,
    private readonly _statsOf: StatsOf = () => Promise.resolve([]),
  ) {
    this.kind = t.kind;
    const mt = t as unknown as WMediaTransceiver;
    this._receive = media ? new MediaReceiver(media, mt) : null;
    this._send = media ? new MediaSender(media, mt) : null;
    this.received = this._receive ?? idleSource(t.kind);
  }

  /** The werift track a sender's media is written into: a new one for each
   *  track the page sends, as `replaceTrack` takes. */
  trackFor(source: MediaSourceLike | null, trackId: string | null): unknown {
    return source
      ? new this._w.MediaStreamTrack({
          kind: this.kind,
          ...(trackId ? { id: trackId } : {}),
        })
      : null;
  }

  /** Sends what a page's track gives, into the werift track its sender
   *  sends from. */
  sendFrom(source: MediaSourceLike | null, track: unknown): void {
    this._send?.attach(source, track as WMediaTrack | null);
  }

  setTrack(source: MediaSourceLike | null, trackId: string | null): void {
    const track = this.trackFor(source, trackId);
    this.t.sender.replaceTrack(track).catch(() => {});
    this.sendFrom(source, track);
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
    // what werift makes of them is held to them (`keepPreferredCodecs`)
    notePreferences(this.t, codecs);
    this.t.setCodecPreferences(chosen);
  }
  /**
   * `[[HeaderExtensionsToNegotiate]]`, as the page's realm last set it,
   * each with whether its direction is still the one it starts with: null
   * until it sets one. What werift offers and answers is the transceiver's
   * `headerExtensions`, written from this before each (`forOffer`,
   * `forAnswer`): werift offers everything its configuration has, and
   * answers everything an offer has that its configuration does.
   */
  private _toNegotiate:
    { uri: string; direction: string; byDefault: boolean }[] | null = null;

  setHeaderExtensionsToNegotiate(extensions: RTCHeaderExtensionChoice[]): void {
    const was = this._negotiable();
    this._toNegotiate = extensions.map((e) => {
      const before = was.find((w) => w.uri === e.uri);
      return {
        uri: e.uri,
        direction: e.direction,
        byDefault: !!before?.byDefault && before.direction === e.direction,
      };
    });
  }

  private _negotiable(): {
    uri: string;
    direction: string;
    byDefault: boolean;
  }[] {
    return (
      this._toNegotiate ??
      OFFERED_EXTENSIONS[this.kind].map((e) => ({
        uri: e.uri,
        direction: e.stoppedByDefault ? 'stopped' : 'sendrecv',
        byDefault: true,
      }))
    );
  }

  /** Before an offer: what werift is to write into this transceiver's
   *  m-section, every extension not stopped, at the id the session gives
   *  its URI where it gives one (RFC 8285, 7), else at its own, else at the
   *  first id nothing else has. One stopped only by default that the
   *  session negotiated, as an app's own offer can have it, is offered
   *  again, as Chrome offers what is unstopped or present. */
  forOffer(): void {
    if (this.t.stopped || this.t.stopping) return;
    const current = this.t.headerExtensions;
    const next: WExtension[] = [];
    const taken = (id: number, uri: string): boolean =>
      next.some((e) => e.id === id) ||
      current.some((e) => e.id === id && e.uri !== uri);
    for (const e of this._negotiable()) {
      if (
        e.direction === 'stopped' &&
        !(e.byDefault && current.some((c) => c.uri === e.uri))
      )
        continue;
      const offered = OFFERED_EXTENSIONS[this.kind].find(
        (o) => o.uri === e.uri,
      );
      if (!offered) continue;
      let id = current.find((c) => c.uri === e.uri)?.id ?? offered.id;
      if (taken(id, e.uri)) {
        id = 1;
        while (id < 15 && taken(id, e.uri)) id += 1;
      }
      next.push(
        new this._w.RTCRtpHeaderExtensionParameters({ uri: e.uri, id }),
      );
    }
    (this.t as { headerExtensions: WExtension[] }).headerExtensions = next;
  }

  /** Before an answer: what the remote offer had that werift knows, less
   *  what the page stopped. An extension stopped only because it starts
   *  so is answered wherever it is offered, as Chrome answers
   *  abs-capture-time. */
  forAnswer(): void {
    const stopped = this._negotiable()
      .filter((e) => e.direction === 'stopped' && !e.byDefault)
      .map((e) => e.uri);
    if (!stopped.length) return;
    (this.t as { headerExtensions: WExtension[] }).headerExtensions =
      this.t.headerExtensions.filter((e) => !stopped.includes(e.uri));
  }

  /** A local description the page changed the `a=extmap` lines of, for
   *  this transceiver's m-section: what werift sends and reads by. Only an
   *  extension werift knows is taken. */
  takeExtensions(ids: Map<number, string>): void {
    const known = OFFERED_EXTENSIONS[this.kind];
    const next = [...ids]
      .filter(([, uri]) => known.some((o) => o.uri === uri))
      .map(
        ([id, uri]) => new this._w.RTCRtpHeaderExtensionParameters({ uri, id }),
      );
    const now = this.t.headerExtensions;
    if (
      next.length === now.length &&
      next.every((e) => now.some((n) => n.id === e.id && n.uri === e.uri))
    )
      return;
    (this.t as { headerExtensions: WExtension[] }).headerExtensions = next;
  }

  /** The codec `setParameters` asked its first encoding to send, which
   *  is sent while the negotiated codecs have it (`_chooseSendCodec`). */
  private _sendCodec: RTCCodecLike | null = null;
  /** Whether werift's sender sends a codec `_sendCodec` chose for it. */
  private _switched = false;

  /**
   * The sender's encodings, as the page's realm last set them: what its
   * `MediaSender` encodes a layer for each of, and the rids werift writes
   * into an offer's `a=rid` and `a=simulcast` lines (`options.simulcast`,
   * read as an offer is made) and an answer's (`answerSimulcast`).
   */
  setParameters(parameters: {
    encodings: RTCEncodingLike[];
    keyFrames?: boolean[];
  }): Promise<void> {
    const encodings = parameters.encodings ?? [];
    this._sendCodec = encodings[0]?.codec ?? null;
    this._chooseSendCodec();
    this.encodings = encodings.map((e) => ({ ...e }));
    const rids = this.rids();
    // encodings with no rid are no streams a receiver could tell apart:
    // the first is sent
    this._send?.setEncodings(
      (rids.length ? encodings : encodings.slice(0, 1)).map((e) => ({
        ...(e.rid !== undefined ? { rid: e.rid } : {}),
        active: e.active !== false,
        ...(e.scaleResolutionDownBy !== undefined
          ? { scaleResolutionDownBy: e.scaleResolutionDownBy }
          : {}),
        ...(e.maxFramerate !== undefined
          ? { maxFramerate: e.maxFramerate }
          : {}),
        ...(e.scaleResolutionDownTo
          ? { scaleResolutionDownTo: { ...e.scaleResolutionDownTo } }
          : {}),
      })),
    );
    parameters.keyFrames?.forEach((key, i) => {
      if (key) this._send?.keyFrameAt(i);
    });
    const t = this.t as unknown as {
      options?: { simulcast?: { rid: string; direction: string }[] };
    };
    if (t.options) {
      t.options.simulcast = rids.length
        ? rids.map((rid) => ({ rid, direction: 'send' }))
        : undefined;
    }
    // the first layer's rid is werift's to write, and no rid where it has
    // none: werift keeps the one it was made with
    const sender = this.t.sender;
    sender.rtpStreamId = rids.length ? encodings[0]?.rid : undefined;
    return Promise.resolve();
  }
  /** Its sender's encodings, last set. */
  encodings: RTCEncodingLike[] = [];
  /** The rids its sender sends, where it sends more than one stream. */
  rids(): string[] {
    return this.kind === 'video' && this.encodings.length > 1
      ? this.encodings.flatMap((e) => (e.rid !== undefined ? [e.rid] : []))
      : [];
  }

  /**
   * The codec werift's sender sends: the one `setParameters` chose, where
   * the negotiated codecs have it, else the first of them, as werift has
   * it. werift has no `setParameters` that changes a sender's codec, and
   * puts its first negotiated one back at every description applied
   * (`prepareSend`), so this is asked again then (`poll`). The media
   * pipeline encodes in whatever the sender's codec is (`./werift-media.ts`).
   */
  private _chooseSendCodec(): void {
    const sender = (this.t as unknown as { sender: WSendCodecs }).sender;
    const negotiated = sender.negotiatedCodecs;
    if (!negotiated?.length) return;
    const isMedia = (c: WCodec): boolean =>
      !['rtx', 'red', 'ulpfec', 'flexfec-03'].includes(
        c.mimeType.toLowerCase().split('/')[1] ?? '',
      );
    const want = this._sendCodec;
    const chosen = want
      ? negotiated.find(
          (c) =>
            isMedia(c) &&
            c.mimeType.toLowerCase() === want.mimeType.toLowerCase() &&
            c.clockRate === want.clockRate &&
            (c.channels ?? 1) === (want.channels ?? 1),
        )
      : // werift's own, where one chosen before was given up
        this._switched
        ? negotiated.find(isMedia)
        : undefined;
    if (want && !chosen) this._sendCodec = null;
    this._switched = !!want && !!chosen;
    // werift's own choice stands where nothing was asked
    if (!chosen || sender.codec === chosen) return;
    sender.codec = chosen;
    sender.sendPrimaryCodec = chosen;
    if (sender.track) sender.track.codec = chosen;
    sender.rtxPayloadType = negotiated.find(
      (c) =>
        c.mimeType.toLowerCase().endsWith('/rtx') &&
        /(?:^|;)\s*apt=(\d+)/.exec(c.parameters ?? '')?.[1] ===
          String(chosen.payloadType),
    )?.payloadType;
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
    this.stopAsked = true;
    this._send?.stop();
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
  /** What a description applied changed: the receiver's werift tracks to
   *  hear, and whether it was ever negotiated to send. */
  poll(currentDirection: RTCDirectionLike | null): void {
    this._receive?.watch();
    if (this._sendCodec) this._chooseSendCodec();
    if (currentDirection === 'sendrecv' || currentDirection === 'sendonly') {
      this.everSent = true;
    }
  }
  /** Whether it is done with: stopped, by the page or by a negotiation. */
  get done(): boolean {
    return this.stopAsked || this.t.stopped || this.t.stopping;
  }
  /** Whether a negotiation took it out, which is when its RTP streams' stats
   *  go (WebRTC Statistics, 3.2): a page's `stop()` alone keeps them until
   *  the description that stops it is applied, as every browser has it. */
  get negotiatedAway(): boolean {
    return this.t.stopped;
  }
  /** The SSRC its sender sends with. */
  get senderSsrc(): number | undefined {
    return (this.t as unknown as WMediaTransceiver).sender?.ssrc;
  }
  /** The SSRCs its receiver heard, or a description named. */
  receiverSsrcs(): Set<number> {
    return this._receive?.ssrcs() ?? new Set();
  }
  /** What its sender adds to its outbound-rtp and media-source stats,
   *  and its receiver to its inbound-rtp. */
  sendStats() {
    return this._send?.stats() ?? { outbound: {}, source: {} };
  }
  /** Its sender's simulcast layers beyond the first, for its stats. */
  sendLayers(): ReturnType<MediaSender['layers']> {
    return this._send?.layers() ?? [];
  }
  receiveStats(): Record<string, unknown> {
    return this._receive?.stats() ?? {};
  }
  /** The connection closed: nothing is sent or heard any more. */
  dispose(): void {
    this._send?.stop();
    this._receive?.end();
  }
  sources() {
    return this._receive?.sources() ?? [];
  }
  setJitterBufferTarget(ms: number | null): void {
    this._receive?.setTarget(ms);
  }
  sendTone(): boolean {
    return false;
  }
  stats(side: 'sender' | 'receiver'): Promise<RTCStatsLike[]> {
    return this._statsOf(this, side);
  }
  transform(
    side: RTCTransformSide,
    frames: ((frame: RTCEncodedFrameLike) => void) | null,
  ): void {
    if (side === 'sender') this._send?.transform(frames);
    else this._receive?.transform(frames);
  }
  writeFrame(side: RTCTransformSide, frame: RTCEncodedFrameLike): void {
    if (side === 'sender') this._send?.write(frame);
    else this._receive?.write(frame);
  }
  keyFrame(rid?: string | null): void {
    this._send?.keyFrame(rid);
  }
  requestKeyFrame(): Promise<void> {
    return this._receive?.requestKeyFrame() ?? Promise.resolve();
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
    // werift asks stun.l.google.com where no STUN server is named, which is
    // a request nobody asked for, and on a network that does not answer it
    // held each setLocalDescription for five seconds
    iceUseDefaultStunServer: false,
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
        (e) => new w.RTCRtpHeaderExtensionParameters({ uri: e.uri, id: e.id }),
      ),
      video: OFFERED_EXTENSIONS.video.map(
        (e) => new w.RTCRtpHeaderExtensionParameters({ uri: e.uri, id: e.id }),
      ),
    },
  };
}

/**
 * Puts back the ids `OFFERED_EXTENSIONS` gives each header extension, which
 * werift numbers again from 1, audio's then video's, as it makes a
 * connection's configuration. Chrome gives one URI one id in every section of
 * a bundle, and Meet's client adds extensions to an offer at ids its sections
 * leave free, so with video's at 5 to 9 it put abs-capture-time at 2, which
 * audio's abs-send-time has, and Google's servers refused the session.
 */
function keepExtensionIds(pc: WPeer): void {
  const { config } = pc as unknown as {
    config?: {
      headerExtensions?: Record<string, { uri: string; id: number }[]>;
    };
  };
  for (const kind of ['audio', 'video'] as const) {
    for (const extension of config?.headerExtensions?.[kind] ?? []) {
      const offered = OFFERED_EXTENSIONS[kind].find(
        (e) => e.uri === extension.uri,
      );
      if (offered) extension.id = offered.id;
    }
  }
}

/**
 * An answer's `a=rid` and `a=simulcast` lines written from what each
 * sender sends (RFC 8853, 5.3): werift's copy the offer's, turned round,
 * with a rid named twice and the choices of a stream as they were, where
 * the answerer sends each rid once and the first of each choice (WebRTC
 * 1.0, 4.4.1.6: what a remote offer's simulcast makes of the encodings).
 * An m-section of a sender that sends one stream has none.
 */
function answerSimulcast(
  sdp: string,
  ridsOf: (mid: string) => string[] | null,
): string {
  return answerLines(sdp, (mid) => {
    const rids = ridsOf(mid);
    if (rids === null) return null;
    return rids.length
      ? [
          ...rids.map((rid) => `a=rid:${rid} send`),
          `a=simulcast:send ${rids.join(';')}`,
        ]
      : [];
  });
}

/** Each m-section's `a=rid` and `a=simulcast` lines, by its mid, where it
 *  has an `a=simulcast`. */
function simulcastLines(sdp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const section of sdp.split(/\r?\nm=/).slice(1)) {
    const lines = section.split(/\r?\n/);
    const mid = lines
      .find((l) => l.startsWith('a=mid:'))
      ?.slice(6)
      .trim();
    const kept = lines.filter(
      (l) => l.startsWith('a=rid:') || l.startsWith('a=simulcast:'),
    );
    if (mid !== undefined && kept.some((l) => l.startsWith('a=simulcast:'))) {
      out.set(
        mid,
        kept.map((l) => l.trim()),
      );
    }
  }
  return out;
}

/** A description werift read back with the `a=rid` and `a=simulcast`
 *  lines it was set with in place of what werift wrote of them. */
function withSimulcast(
  sdp: string | null,
  lines: Map<string, string[]> | null,
): string | null {
  if (sdp === null || !lines?.size) return sdp;
  return answerLines(sdp, (mid) => lines.get(mid) ?? null);
}

/** A description each of whose m-sections has the `a=rid` and
 *  `a=simulcast` lines `linesOf` gives its mid in place of its own, or its
 *  own where it gives null. */
function answerLines(
  sdp: string,
  linesOf: (mid: string) => string[] | null,
): string {
  const lines = sdp.split('\r\n');
  const out: string[] = [];
  let section: string[] | null = null;
  const flush = () => {
    if (!section) return;
    const mid = section.find((l) => l.startsWith('a=mid:'))?.slice(6);
    const own = mid === undefined ? null : linesOf(mid);
    if (own === null) out.push(...section);
    else {
      const kept = section.filter(
        (l) => !l.startsWith('a=rid:') && !l.startsWith('a=simulcast:'),
      );
      const end = kept.length && kept[kept.length - 1] === '' ? 1 : 0;
      out.push(...kept.slice(0, kept.length - end), ...own);
      out.push(...kept.slice(kept.length - end));
    }
    section = null;
  };
  for (const line of lines) {
    if (line.startsWith('m=')) {
      flush();
      section = [line];
    } else if (section) section.push(line);
    else out.push(line);
  }
  flush();
  return out.join('\r\n');
}

/**
 * Routes a packet by its MID where nothing else names it (RFC 8843, 9.2).
 * werift's router reads a packet's SSRC, or its rid, and drops one that
 * carries neither an SSRC a description named nor a rid: an offer with no
 * `a=ssrc` lines, as WPT's simulcast harness makes from a browser's, has
 * every packet dropped. A packet of an unknown SSRC that names the MID of a
 * receiving transceiver, and no rid, is routed to that receiver as werift
 * routes a rid it heard, its SSRC kept as one learned from a packet.
 * werift has no public way to do this, so this wraps its router's
 * `routeRtp`; a werift without the fields routes as before.
 */
function routeByMid(pc: WPeer): void {
  type Route = (packet: {
    header: { ssrc: number; extensions: { id: number; payload: Uint8Array }[] };
  }) => void;
  const router = (
    pc as unknown as {
      router?: {
        routeRtp?: Route;
        ssrcTable?: Record<number, unknown>;
        extIdUriMap?: Record<number, string>;
        learnedSsrcs?: Set<number>;
        registerRtpReceiverBySsrc?(
          t: unknown,
          params: {
            encodings: { ssrc: number }[];
            codecs: WCodec[];
            headerExtensions: [];
          },
        ): void;
      };
    }
  ).router;
  const route = router?.routeRtp;
  if (
    !router ||
    typeof route !== 'function' ||
    !router.ssrcTable ||
    !router.extIdUriMap ||
    typeof router.registerRtpReceiverBySsrc !== 'function'
  )
    return;
  const decoder = new TextDecoder();
  router.routeRtp = (packet) => {
    const { ssrc, extensions } = packet.header;
    if (!(ssrc in router.ssrcTable!)) {
      let mid: string | null = null;
      let rid = false;
      for (const e of extensions) {
        const uri = router.extIdUriMap![e.id];
        if (uri === MID_URI) mid = decoder.decode(e.payload);
        else if (uri === RID_URI) rid = true;
      }
      const t =
        mid !== null && !rid
          ? pc
              .getTransceivers()
              .find(
                (x) =>
                  x.mid === mid &&
                  !x.stopped &&
                  (x.currentDirection === 'recvonly' ||
                    x.currentDirection === 'sendrecv' ||
                    x.direction === 'recvonly' ||
                    x.direction === 'sendrecv'),
              )
          : undefined;
      if (t) {
        router.registerRtpReceiverBySsrc!(t, {
          encodings: [{ ssrc }],
          codecs: t.codecs,
          headerExtensions: [],
        });
        router.learnedSsrcs?.add(ssrc);
      }
    }
    route.call(router, packet);
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
  /** werift's packetizers, where it has them: what the media pipeline
   *  stands on. */
  private readonly _media: WeriftMediaModule | null;
  /** The m-lines of the remote offer's m-sections of kinds werift does
   *  not read, by mid: rejected in the answer as their own kinds. */
  private _unknown = new Map<string, string>();
  /** What the last answer negotiated each transceiver to, read from the
   *  answer itself: werift sets none for one stopping, or `inactive`. */
  private readonly _negotiated = new WeakMap<WTransceiver, RTCDirectionLike>();
  private _closed = false;
  /** Whether a description was ever applied: before one there is no
   *  transport to have stats of, nor a certificate it uses. */
  private _described = false;
  /** The page's servers, which a gathering is checked against
   *  (`_checkServers`), and what was checked last. */
  private _servers: RTCConnectRequest['iceServers'];
  private _serversChecked = '';

  constructor(
    private readonly _w: WeriftModule,
    request: RTCConnectRequest,
    private readonly _events: RTCConnectionEvents,
    certificates: Map<number, WCertificate>,
  ) {
    const config = configOf(request, _w, certificates);
    this._pc = new _w.RTCPeerConnection(config);
    keepExtensionIds(this._pc);
    routeByMid(this._pc);
    keepPreferredCodecs(this._pc);
    const codecs = config.codecs as { audio: WCodec[]; video: WCodec[] };
    this._codecs = [...codecs.audio, ...codecs.video];
    this._net = new WeriftTransports(this._pc, _events, () => this._closed);
    this._media = hasMedia(_w) ? _w : null;
    this._servers = request.iceServers;
  }

  /**
   * Tells the page, as an `icecandidateerror`, of each of its servers no
   * candidate could reach (`unreachableServers`), once for each gathering:
   * a local description with ufrags not checked before, or servers that
   * changed. Each is named with the host candidate that would have asked it,
   * as Firefox names one; with none, the address and port are null.
   */
  private _checkServers(): void {
    const sdp =
      (this._pc.pendingLocalDescription ?? this._pc.currentLocalDescription)
        ?.sdp ?? '';
    const ufrags = (sdp.match(/^a=ice-ufrag:\S+/gm) ?? []).join(' ');
    if (!ufrags || this._servers.length === 0) return;
    const key = `${ufrags}\n${JSON.stringify(this._servers)}`;
    if (key === this._serversChecked) return;
    this._serversChecked = key;
    void unreachableServers(this._servers).then((failures) => {
      if (this._closed) return;
      for (const f of failures) {
        const host = hostCandidateOf(sdp, f.family);
        this._events.candidateError({
          address: host?.address ?? null,
          port: host?.port ?? null,
          url: f.url,
          errorCode: f.errorCode,
          errorText: f.errorText,
        });
      }
    });
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
      w = new WeriftTransceiver(
        t,
        this._w,
        this._codecs,
        this._session,
        this._media,
        (x, side) => this._selected(x, side),
      );
      this._wrapped.set(t, w);
    }
    return w;
  }

  /** The stand-ins for the remote offer's rejected m-sections, by mid. */
  private readonly _rejected = new Map<string, RTCTransceiverLike>();
  private _rejectedOf(
    mid: string,
    kind: 'audio' | 'video',
  ): RTCTransceiverState {
    let t = this._rejected.get(mid);
    if (!t || t.kind !== kind) {
      t = standIn(kind);
      this._rejected.set(mid, t);
    }
    const none: RTCRtpParametersLike = {
      codecs: [],
      headerExtensions: [],
      rtcp: { cname: this._pc.cname, reducedSize: false },
    };
    return {
      transceiver: t,
      mid,
      direction: 'stopped',
      currentDirection: null,
      remoteDirection: 'inactive',
      stopped: false,
      sender: { transport: null, parameters: none },
      receiver: { transport: null, parameters: none, streams: [] },
      headerExtensions: [],
    };
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
        const currentDirection = (this._negotiated.get(t) ??
          (t.currentDirection as RTCDirectionLike | null) ??
          null) as RTCDirectionLike | null;
        const wrapped = this._wrap(t);
        wrapped.poll(currentDirection);
        return {
          transceiver: wrapped,
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
          currentDirection,
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
    // a remote offer's rejected m-section werift made nothing of: a
    // transceiver of its own, stopped at once, as WebRTC 1.0 has it
    // (4.4.1.6), until the answer takes it out
    if (this._pc.signalingState === 'have-remote-offer') {
      for (const [mid, section] of remote) {
        if (!section.rejected) continue;
        if (section.kind !== 'audio' && section.kind !== 'video') continue;
        if (this._pc.getTransceivers().some((t) => t.mid === mid)) continue;
        // an unknown kind's stand-in is no transceiver of its own
        if (this._unknown.has(mid)) continue;
        // in the m-sections' order, as the offer made them one by one
        const order = [...remote.keys()];
        const at = transceivers.findIndex(
          (t) => t.mid !== null && order.indexOf(t.mid) > order.indexOf(mid),
        );
        const standing = this._rejectedOf(mid, section.kind);
        if (at < 0) transceivers.push(standing);
        else transceivers.splice(at, 0, standing);
      }
    }
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
      if (side === 'local') text = withoutNoStream(text);
      else text = asWeriftReads(udpCandidatesOnly(text));
      if (type !== 'rollback') {
        // a kind werift does not read throws in its parser: it is handed a
        // rejected audio m-section in that one's place, and the answer
        // puts the kind back (`restoreUnknown`)
        const stood = standInUnknown(text);
        text = stood.sdp;
        if (side === 'remote' && type === 'offer') this._unknown = stood.lines;
      }
      // werift sets no offer but the last it made, where Chrome takes one a
      // page changed: Meet adds simulcast layers and header extensions to
      // each before it sets it. werift is handed its own, so what the page
      // added is neither sent nor in the local description it reads back
      // The header extensions it added or took out are taken, though: they
      // are written into werift's transceivers and the offer made again
      // from them, which is what an app that turns abs-capture-time on by
      // hand asks for
      if (side === 'local' && (type === 'offer' || type === 'answer')) {
        const pc = this._pc as unknown as {
          createdOffer?: {
            sdp: string;
            transceiverByMid?: Map<string, WTransceiver>;
          };
        };
        const created = pc.createdOffer;
        if (type === 'offer' && created && text !== created.sdp) {
          if (this._takeExtensions(text, created.transceiverByMid)) {
            await this._offer();
          }
          text = pc.createdOffer?.sdp ?? created.sdp;
        } else if (type === 'answer') {
          this._takeExtensions(text, undefined);
        }
      }
      const description = type === 'rollback' ? { type } : { type, sdp: text };
      if (side === 'local') {
        await this._pc.setLocalDescription(description);
      } else await this._pc.setRemoteDescription(description);
    } catch (error) {
      throw asRtcError(error);
    }
    if (type !== 'rollback') this._described = true;
    this._watchTransports();
    this._tellTransports();
    if (side === 'local' && type !== 'rollback') this._checkServers();
    if (type === 'answer' || type === 'pranswer')
      this._noteNegotiated(side, sdp);
    this._noteSimulcast(side, type, sdp);
    this._offered = false;
    return this._state();
  }

  /** The `a=rid` and `a=simulcast` lines of each m-section of the remote
   *  descriptions as they were set: werift writes a stream's choices out
   *  of what it reads back, and a page reads the description it set. */
  private _simulcastPending: Map<string, string[]> | null = null;
  private _simulcastCurrent: Map<string, string[]> | null = null;
  private _noteSimulcast(
    side: 'local' | 'remote',
    type: string,
    sdp: string,
  ): void {
    if (side === 'remote') {
      if (type === 'rollback') this._simulcastPending = null;
      else if (type === 'answer') {
        this._simulcastCurrent = simulcastLines(sdp);
        this._simulcastPending = null;
      } else this._simulcastPending = simulcastLines(sdp);
    } else if (type === 'answer') {
      this._simulcastCurrent = this._simulcastPending ?? this._simulcastCurrent;
      this._simulcastPending = null;
    }
  }

  /** Each m-section's header extensions of a local description, into the
   *  transceiver it is: whether any changed. */
  private _takeExtensions(
    sdp: string,
    byMid: Map<string, WTransceiver> | undefined,
  ): boolean {
    let changed = false;
    for (const [mid, ids] of extmapsOf(sdp)) {
      const t =
        byMid?.get(mid) ??
        this._pc.getTransceivers().find((x) => x.mid === mid);
      const w = t ? this._wrapped.get(t) : undefined;
      if (!t || !w) continue;
      const before = t.headerExtensions.map((e) => `${e.id} ${e.uri}`).join();
      w.takeExtensions(ids);
      if (t.headerExtensions.map((e) => `${e.id} ${e.uri}`).join() !== before)
        changed = true;
    }
    return changed;
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
    const wrapped = this._wrap(t);
    void wrapped.setParameters({ encodings: init.sendEncodings });
    wrapped.sendFrom(init.source, track);
    return wrapped;
  }

  /**
   * werift's `createOffer`, with each transceiver a negotiation has
   * narrowed offering again every codec it supports (`reofferCodecs`,
   * werift#818): its codecs are widened for the offer alone, and put back
   * after, so the sender's parameters stay what was negotiated until an
   * answer says otherwise. The offer set carries the wider list, which is
   * what werift answers it from (`pendingLocalOfferCodecs`). The full list
   * is werift's own resolution, the one an initial offer has, which the
   * adapter reaches its transceiver manager for.
   */
  private async _offer(options?: {
    iceRestart?: boolean;
  }): Promise<WDescription> {
    const tm = (
      this._pc as unknown as {
        transceiverManager?: { assignTransceiverCodecs?(t: unknown): void };
      }
    ).transceiverManager;
    const widened: [{ codecs: WCodec[] }, WCodec[]][] = [];
    for (const t of this._pc.getTransceivers()) {
      const r = t as unknown as {
        codecs: WCodec[];
        codecPreferencesNeedResolution?: boolean;
      };
      if (
        typeof tm?.assignTransceiverCodecs !== 'function' ||
        t.stopped ||
        t.stopping ||
        !t.currentDirection ||
        r.codecPreferencesNeedResolution ||
        r.codecs.length === 0
      )
        continue;
      const negotiated = r.codecs;
      try {
        tm.assignTransceiverCodecs(t);
      } catch {
        r.codecs = negotiated;
        continue;
      }
      r.codecs = reofferCodecs(negotiated, r.codecs, (c, pt, parameters) =>
        this._copyCodec(c, pt, parameters),
      ) as WCodec[];
      widened.push([r, negotiated]);
    }
    try {
      return await this._pc.createOffer(options);
    } finally {
      for (const [r, negotiated] of widened) r.codecs = negotiated;
    }
  }

  /** A werift codec at another payload type, and with other parameters. */
  private _copyCodec(
    c: WCodecLike,
    payloadType: number,
    parameters?: string,
  ): WCodecLike {
    const fmtp = parameters ?? c.parameters;
    return new this._w.RTCRtpCodecParameters({
      mimeType: c.mimeType,
      clockRate: c.clockRate,
      payloadType,
      ...(c.channels !== undefined ? { channels: c.channels } : {}),
      ...(fmtp ? { parameters: fmtp } : {}),
      ...(c.rtcpFeedback ? { rtcpFeedback: c.rtcpFeedback } : {}),
    }) as WCodecLike;
  }

  async createOffer(options: { iceRestart: boolean }): Promise<string> {
    for (const w of this._wrapped.values()) {
      w.flushStop();
      w.forOffer();
    }
    try {
      const offer = (await this._offer({ iceRestart: options.iceRestart })).sdp;
      this._offered = true;
      return namingNoStream(offer);
    } catch (error) {
      throw asRtcError(error);
    }
  }

  async createAnswer(): Promise<string> {
    for (const w of this._wrapped.values()) {
      w.flushStop();
      w.forAnswer();
    }
    try {
      return namingNoStream(
        restoreUnknown(
          answerSimulcast((await this._pc.createAnswer()).sdp, (mid) => {
            const t = this._pc.getTransceivers().find((x) => x.mid === mid);
            const w = t ? this._wrapped.get(t) : undefined;
            return w ? w.rids() : null;
          }),
          this._unknown,
        ),
      );
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
    // one werift cannot use is ignored, as a browser ignores it
    if (candidate?.candidate && !overUdp(candidate.candidate)) return;
    try {
      await this._pc.addIceCandidate(
        candidate
          ? {
              // the SDP framing's `a=`, which the page's realm lets
              // through as every browser does, is no part of the attribute
              // werift parses: it threw "Failed to parse ICE candidate"
              candidate: candidate.candidate.replace(/^a=/, ''),
              sdpMid: candidate.sdpMid ?? undefined,
              sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
              usernameFragment: candidate.usernameFragment ?? undefined,
            }
          : null,
      );
    } catch (error) {
      throw asRtcError(error);
    }
    // a transport held at new for want of a candidate checks now
    this._net.tell();
  }

  restartIce(): void {
    this._pc.restartIce();
  }

  setConfiguration(request: RTCConnectRequest): void {
    this._servers = request.iceServers;
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
    const local = (d: WDescription | null | undefined): string | null =>
      d ? namingNoStream(as(d)!) : null;
    return {
      currentLocal: local(pc.currentLocalDescription),
      pendingLocal: local(pc.pendingLocalDescription),
      currentRemote: withSimulcast(
        as(pc.currentRemoteDescription),
        this._simulcastCurrent,
      ),
      pendingRemote: withSimulcast(
        as(pc.pendingRemoteDescription),
        this._simulcastPending,
      ),
    };
  }

  createDataChannel(init: RTCDataChannelInitLike): RTCDataChannelLike {
    return this._net.channel(init);
  }

  /**
   * The connection's stats, its RTP streams' as long as WebRTC Statistics
   * has them live (3.2): an outbound-rtp from the answer that first
   * negotiated its sender to send, which werift has from the transceiver's
   * making, and an inbound-rtp from its first packet, which werift has from
   * the description that named its SSRC. Neither of a transceiver stopped.
   * Each names its transceiver's mid, which the page's realm finds its
   * track by, and the remote streams and codecs go with what they are of.
   */
  async stats(): Promise<RTCStatsLike[]> {
    // the transceivers as they are when the page asked, which a stop it
    // asks for next does not change
    type Seen = { mid: string | null; live: boolean; w: WeriftTransceiver };
    const senders = new Map<number, Seen>();
    const receivers = new Map<number, Seen>();
    for (const w of this._wrapped.values()) {
      const mid = w.t.mid;
      const live = !w.negotiatedAway && !this._closed;
      if (w.senderSsrc !== undefined) {
        senders.set(w.senderSsrc, { mid, live: w.everSent && live, w });
      }
      for (const ssrc of w.receiverSsrcs()) {
        receivers.set(ssrc, { mid, live, w });
      }
    }
    const list = await this._net.stats();
    const byId = new Map(list.map((s) => [s.id, s]));
    // a simulcast sender's layers beyond the first, which werift's stats
    // know nothing of: each an outbound-rtp of its own, of its own SSRC,
    // rid and index (WebRTC Statistics, 5.6)
    const layers: RTCStatsLike[] = [];
    const live = list.filter((s) => {
      if (s.type === 'outbound-rtp' || s.type === 'inbound-rtp') {
        const seen = (s.type === 'outbound-rtp' ? senders : receivers).get(
          Number(s.ssrc),
        );
        if (!seen || !seen.live) return false;
        if (s.type === 'inbound-rtp' && !(Number(s.packetsReceived) > 0)) {
          return false;
        }
        if (s.mid === undefined && seen.mid !== null) s.mid = seen.mid;
        // what werift leaves out at 0, and what the media pipeline counts
        s.nackCount ??= 0;
        s.firCount ??= 0;
        s.pliCount ??= 0;
        if (s.type === 'outbound-rtp') {
          s.retransmittedPacketsSent ??= 0;
          s.retransmittedBytesSent ??= 0;
          const { outbound, source } = seen.w.sendStats();
          Object.assign(s, outbound);
          const media = byId.get(String(s.mediaSourceId));
          if (media?.type === 'media-source') Object.assign(media, source);
          for (const layer of seen.w.sendLayers()) {
            const copy: RTCStatsLike = {
              ...s,
              ...layer.outbound,
              id: `${s.id}-${layer.ssrc}`,
              ssrc: layer.ssrc,
              encodingIndex: layer.encodingIndex,
              nackCount: 0,
              firCount: 0,
              pliCount: 0,
              retransmittedPacketsSent: 0,
              retransmittedBytesSent: 0,
            };
            delete copy.remoteId;
            delete copy.rid;
            if (layer.rid !== undefined) copy.rid = layer.rid;
            layers.push(copy);
          }
        } else Object.assign(s, seen.w.receiveStats());
        return true;
      }
      // a transport, and the certificate and candidates it has, are a
      // description's: werift makes them as its connection is made
      return this._described || !BEFORE_DESCRIPTION.has(s.type);
    });
    const playout = audioPlayout(live);
    if (playout) live.push(playout);
    live.push(...layers);
    const ids = new Set(live.map((s) => s.id));
    const kept = live.filter(
      (s) =>
        (s.type !== 'remote-inbound-rtp' && s.type !== 'remote-outbound-rtp') ||
        ids.has(String(s.localId)),
    );
    for (const s of kept) {
      if (s.remoteId !== undefined && !ids.has(String(s.remoteId))) {
        delete s.remoteId;
      }
    }
    const codecs = new Set(kept.map((s) => s.codecId).filter(Boolean));
    return kept.filter((s) => s.type !== 'codec' || codecs.has(s.id));
  }

  /**
   * A sender's or a receiver's stats (WebRTC 1.0, 8.5, the stats selection
   * algorithm): its RTP streams, and every object they name, and those name,
   * by the `…Id` fields that refer to another.
   */
  private async _selected(
    t: WeriftTransceiver,
    side: 'sender' | 'receiver',
  ): Promise<RTCStatsLike[]> {
    const ssrcs = side === 'receiver' ? t.receiverSsrcs() : null;
    const sent = new Set([t.senderSsrc, ...t.sendLayers().map((l) => l.ssrc)]);
    const all = await this.stats();
    const byId = new Map(all.map((s) => [s.id, s]));
    const queue = all.filter((s) =>
      side === 'sender'
        ? s.type === 'outbound-rtp' && sent.has(Number(s.ssrc))
        : s.type === 'inbound-rtp' && ssrcs!.has(Number(s.ssrc)),
    );
    const out = new Map<string, RTCStatsLike>();
    while (queue.length) {
      const s = queue.shift()!;
      if (out.has(s.id)) continue;
      out.set(s.id, s);
      for (const [key, value] of Object.entries(s)) {
        if (!key.endsWith('Id') || typeof value !== 'string') continue;
        const next = byId.get(value);
        if (next) queue.push(next);
      }
    }
    return [...out.values()];
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const w of this._wrapped.values()) w.dispose();
    this._pc.close().catch(() => {});
  }
}

/** The stats of what a connection has only once a description is applied. */
const BEFORE_DESCRIPTION = new Set([
  'transport',
  'certificate',
  'local-candidate',
  'remote-candidate',
  'candidate-pair',
]);

/**
 * The connection's audio playout (WebRTC Statistics, 5.11,
 * RTCAudioPlayoutStats): one for the device every audio receiver plays out
 * on, as Chrome has it, from the first inbound-rtp of audio, which names it
 * by its `playoutId`. Nothing is synthesized here: what is played out is
 * what was decoded, a sample's delay its time in the jitter buffer.
 */
function audioPlayout(list: RTCStatsLike[]): RTCStatsLike | null {
  const audio = list.filter(
    (s) => s.type === 'inbound-rtp' && s.kind === 'audio',
  );
  if (!audio.length) return null;
  const id = 'AP';
  let count = 0;
  let duration = 0;
  let delay = 0;
  let timestamp = 0;
  for (const s of audio) {
    s.playoutId = id;
    count += Number(s.totalSamplesReceived) || 0;
    duration += Number(s.totalSamplesDuration) || 0;
    delay += Number(s.jitterBufferDelay) || 0;
    timestamp = Math.max(timestamp, Number(s.timestamp) || 0);
  }
  return {
    id,
    type: 'media-playout',
    timestamp,
    kind: 'audio',
    synthesizedSamplesDuration: 0,
    synthesizedSamplesEvents: 0,
    totalSamplesDuration: duration,
    totalPlayoutDelay: delay,
    totalSamplesCount: count,
  };
}

/** A transceiver nothing carries: it takes what the page sets, and its
 *  receiver receives nothing. */
function standIn(kind: 'audio' | 'video'): RTCTransceiverLike {
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

/** A connection werift is not there to carry: every operation that needs
 *  it rejects. */
function unavailable(why: string): RTCConnectionLike {
  const no = () => Promise.reject(rtcError('NotSupportedError', why));
  return {
    addTransceiver: (init) => standIn(init.kind),
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
