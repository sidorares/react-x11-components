// A page's peer connections on the host's side: what the facade's
// `RTCPeerConnection` asks for (the `rtc…` ops) carried over the host's
// seam (`HtmlScripts.webRTC`), and what becomes of each connection told
// back to the page through entries (`__rtc…`).
//
// Only primitives cross, as everywhere on the bridge: a connection, a
// transceiver, a data channel and a transport are numbers, bytes are
// base64, and what an entry is handed is JSON. The facade numbers its
// connections; the host numbers what a connection holds, since a remote
// offer makes transceivers the page never asked for. An error crosses as
// its name, its message and an `RTCError`'s detail, which the facade makes
// into its own.
//
// **A data channel handed to a worker stays the page process's.** The
// channel is the seam's, and a worker's thread has no seam of its own, so
// what the worker's realm asks of it crosses the thread as a
// `ChannelRelay` and this side does it; what becomes of the channel goes
// back the same way, held until the worker has made its own of it
// (`adopt`), as WebTransport's sessions do (`transport-relay.ts`).
//
// **A transform's frames go to its worker and back.** `sender.transform`
// and `receiver.transform` take an `RTCRtpScriptTransform`, which is a
// worker's, and the frames of that side are the seam's: each is handed
// across the worker's thread to its realm's transformer (`tf`, `frame`), and
// goes on only once the worker writes it back (`tfAsk`, `write`), which this
// side hands to the seam. What the worker's realm asks of a transform it has
// not been told of goes nowhere.
//
// **What a connection tells waits for the description being applied.**
// A stack may gather a candidate or move a transport while
// `setLocalDescription` is still under way, and WebRTC 1.0 tells the page
// of neither before that operation's promise settles. So a connection's
// events are held while one of its descriptions is applied, and told after
// its answer.

import { NO_WEBRTC } from '../rtc.js';
import type {
  HtmlWebRTC,
  RTCConnectRequest,
  RTCConnectionLike,
  RTCDataChannelLike,
  RTCEncodedFrameLike,
  RTCSessionState,
  RTCStatsLike,
  RTCTransceiverLike,
  RTCTransformSide,
  RTCTransportStateLike,
} from '../rtc.js';
import type { PageSources, SourceTap, TrackOutput } from './media-sources.js';
import type { BufferClass } from './platform.js';

declare const Buffer: BufferClass;
declare const queueMicrotask: (fn: () => void) => void;
declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const performance: { readonly timeOrigin: number; now(): number };

/** An RTP stream's stats that name the hardware coding it. */
const HARDWARE_FIELDS = [
  'encoderImplementation',
  'powerEfficientEncoder',
  'decoderImplementation',
  'powerEfficientDecoder',
  'psnrSum',
  'psnrMeasurements',
];

/** A value a task later. */
const later = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 0));

type Primitive = string | number | boolean | null | undefined;

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64',
  );
}
function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** What crosses a worker's thread for a data channel the page handed it,
 *  by the page process's number for it: the worker's asks, and what
 *  becomes of the channel. */
export type ChannelRelay =
  | { kind: 'rtc'; op: 'adopt'; ch: number }
  | { kind: 'rtc'; op: 'send'; ch: number; binary: boolean; data: string }
  | { kind: 'rtc'; op: 'close'; ch: number }
  | { kind: 'rtc'; op: 'event'; ch: number; k: string; v: unknown }
  /** To a worker, of a transform of its: put on a side or taken off
   *  (`attach`, `detach`), a frame of that side's, a key frame request
   *  answered (`settled`). */
  | { kind: 'rtc'; op: 'tf'; tf: number; e: string; v: unknown }
  /** From a worker, of a transform of its: a frame written back, a key
   *  frame generated or asked of the peer. */
  | { kind: 'rtc'; op: 'tfAsk'; tf: number; e: string; v: unknown };

/** An encoded frame as it crosses a thread: its bytes as base64. */
interface FrameWire {
  k: 'audio' | 'video';
  y: 'key' | 'delta' | 'empty';
  d: string;
  m: Record<string, unknown>;
  /** When the host sent it, as `performance.timeOrigin +
   *  performance.now()` reads it: what `m`'s times are made the
   *  receiving realm's from. */
  t?: number;
}
const frameWire = (f: RTCEncodedFrameLike): FrameWire => ({
  k: f.kind,
  y: f.type,
  d: base64Of(f.data),
  m: f.metadata,
  // when it was sent, on the clock its times are on, which the realm it
  // goes to has no other way to read (`__rtcTf`)
  t: performance.timeOrigin + performance.now(),
});
function frameOfWire(v: unknown): RTCEncodedFrameLike | null {
  const w = v as Partial<FrameWire> | null;
  if (!w || (w.k !== 'audio' && w.k !== 'video') || typeof w.d !== 'string') {
    return null;
  }
  return {
    kind: w.k,
    type: w.y === 'delta' || w.y === 'empty' ? w.y : 'key',
    data: bytesOf(w.d),
    metadata: w.m && typeof w.m === 'object' ? w.m : {},
  };
}

/** A transform put on a side of a transceiver: its worker's. */
interface Transform {
  tf: number;
  tx: number;
  side: RTCTransformSide;
  worker: number;
}

/** What the page's connections are carried over, and how it is told. */
export interface PeerSeams {
  /** The seam, read as each connection is made. */
  webRTC(): HtmlWebRTC | undefined;
  /** The page's origin. */
  origin(): string;
  /** The page's media sources, which a receiver's is numbered among. */
  sources(): PageSources;
  /** An entry of the page's, with its input. */
  tell(entry: string, input: unknown): void;
  /** A page's: tells a worker's thread of a channel handed to it. */
  toWorker?(worker: number, message: ChannelRelay): void;
  /** A worker's: asks the page process of a channel it was handed. */
  toPage?(message: ChannelRelay): void;
}

/** A channel handed to a worker, and what it told before the worker had
 *  made its own. */
interface Moved {
  worker: number;
  adopted: boolean;
  held: ChannelRelay[];
}

interface Peer {
  id: number;
  connection: RTCConnectionLike;
  /** How many of its descriptions are being applied. */
  applying: number;
  /** What it told meanwhile. */
  held: [string, unknown][];
  closed: boolean;
}

interface Transceiver {
  id: number;
  peer: Peer;
  transceiver: RTCTransceiverLike;
  /** Its receiver's source, as the page's tracks number it. */
  source: number;
  /** What its sender reads its track through, which the track's output is
   *  set on (`rtcTrackOutput`), or null. */
  sending: SourceTap | null;
}

/** A track's output as the page's realm says it: what a sender of it
 *  sends. */
const outputOf = (v: Primitive): TrackOutput =>
  v === 'disabled' || v === 'ended' ? v : 'enabled';

interface Channel {
  id: number;
  peer: Peer;
  channel: RTCDataChannelLike;
}

/** An error as it crosses to the page. */
function errorOf(error: unknown): unknown {
  const e = error as {
    name?: unknown;
    message?: unknown;
    detail?: unknown;
  };
  return {
    name: typeof e?.name === 'string' && e.name ? e.name : 'OperationError',
    message: String(e?.message ?? error),
    ...(e?.detail ? { detail: e.detail } : {}),
  };
}

/**
 * The origin each certificate was made for, by the seam that made it: the
 * host's record, since what a page's realm keeps of a certificate's origin
 * is the page's to change. A certificate of another origin, or of an opaque
 * one, is no certificate of a connection's (WebRTC 1.0, 4.4.1.1); the realm
 * refuses it first, and a realm talked round has it left out here.
 */
const CERTIFICATE_ORIGINS = new WeakMap<
  object,
  Map<number, { origin: string; owner: PagePeers }>
>();

export class PagePeers {
  private readonly _peers = new Map<number, Peer>();
  private readonly _transceivers = new Map<number, Transceiver>();
  private readonly _ids = new Map<RTCTransceiverLike, number>();
  private readonly _channels = new Map<number, Channel>();
  /** The page's channels handed to a worker, by number. */
  private readonly _moved = new Map<number, Moved>();
  /** The transforms put on a side, by the page's number for each. */
  private readonly _transforms = new Map<number, Transform>();
  private _seq = 0;
  private _disposed = false;

  constructor(private readonly _seams: PeerSeams) {}

  /** Whether a connection is not closed: what keeps a document out of the
   *  back-forward cache, where its peer would see it held. */
  get open(): boolean {
    for (const peer of this._peers.values()) if (!peer.closed) return true;
    return false;
  }

  /** An op of the facade's whose name starts with `rtc`. */
  op(
    op: string,
    a: Primitive,
    b: Primitive,
    c: Primitive,
    d: Primitive,
  ): Primitive {
    const text = (v: Primitive): string => (typeof v === 'string' ? v : '');
    const json = (v: Primitive): unknown => {
      try {
        return JSON.parse(text(v));
      } catch {
        return null;
      }
    };
    switch (op) {
      case 'rtcOpen':
        this._open(Number(a), json(b) as RTCConnectRequest);
        return null;
      case 'rtcClose': {
        const peer = this._peers.get(Number(a));
        if (peer) this._close(peer);
        return null;
      }
      case 'rtcConfigure': {
        const peer = this._peers.get(Number(a));
        const request = json(b) as RTCConnectRequest | null;
        if (peer && request) {
          peer.connection.setConfiguration({
            ...request,
            origin: this._seams.origin(),
          });
        }
        return null;
      }
      case 'rtcRestartIce':
        this._peers.get(Number(a))?.connection.restartIce();
        return null;
      case 'rtcDescriptions': {
        const peer = this._peers.get(Number(a));
        return JSON.stringify(
          peer
            ? peer.connection.descriptions()
            : {
                currentLocal: null,
                pendingLocal: null,
                currentRemote: null,
                pendingRemote: null,
              },
        );
      }
      case 'rtcCapabilities': {
        const kind = text(a) === 'video' ? 'video' : 'audio';
        const side = text(b) === 'receiver' ? 'receiver' : 'sender';
        const seam = this._seams.webRTC() ?? NO_WEBRTC;
        const capabilities = seam.capabilities(kind, side);
        return capabilities ? JSON.stringify(capabilities) : null;
      }
      case 'rtcAddTransceiver':
        return this._addTransceiver(Number(a), json(b));
      case 'rtcDirection': {
        const t = this._transceivers.get(Number(a));
        const direction = text(b);
        if (
          t &&
          (direction === 'sendrecv' ||
            direction === 'sendonly' ||
            direction === 'recvonly' ||
            direction === 'inactive')
        ) {
          t.transceiver.setDirection(direction);
        }
        return null;
      }
      case 'rtcStopTransceiver':
        this._transceivers.get(Number(a))?.transceiver.stop();
        return null;
      case 'rtcByTrack':
        this._transceivers.get(Number(a))?.transceiver.madeByAddTrack?.();
        return null;
      case 'rtcStreams': {
        const ids = json(b);
        this._transceivers
          .get(Number(a))
          ?.transceiver.setStreams(Array.isArray(ids) ? ids.map(String) : []);
        return null;
      }
      case 'rtcExtensions': {
        const list = json(b);
        this._transceivers
          .get(Number(a))
          ?.transceiver.setHeaderExtensionsToNegotiate(
            Array.isArray(list) ? list : [],
          );
        return null;
      }
      case 'rtcCodecs': {
        const codecs = json(b);
        this._transceivers
          .get(Number(a))
          ?.transceiver.setCodecPreferences(
            Array.isArray(codecs) ? codecs : [],
          );
        return null;
      }
      case 'rtcTrack': {
        const t = this._transceivers.get(Number(a));
        if (!t) return null;
        // a tap of the page's source, which the sender reads its frames
        // through beside whatever else reads them, as the track gives them
        const source =
          Number(b) >= 0
            ? this._seams.sources().tap(Number(b), outputOf(d))
            : null;
        t.sending = source;
        t.transceiver.setTrack(source, source ? text(c) || null : null);
        return null;
      }
      case 'rtcTrackOutput':
        this._transceivers.get(Number(a))?.sending?.output(outputOf(b));
        return null;
      case 'rtcTone':
        this._transceivers
          .get(Number(a))
          ?.transceiver.sendTone(text(b), Number(c));
        return null;
      case 'rtcJitter': {
        const ms = b === null || b === undefined ? null : Number(b);
        this._transceivers
          .get(Number(a))
          ?.transceiver.setJitterBufferTarget(ms);
        return null;
      }
      case 'rtcSources': {
        const t = this._transceivers.get(Number(a));
        return JSON.stringify(t ? t.transceiver.sources() : []);
      }
      case 'rtcParameters': {
        const t = this._transceivers.get(Number(a));
        const parameters = json(c) as {
          encodings?: unknown[];
          keyFrames?: boolean[];
        } | null;
        this._settle(
          Number(b),
          t
            ? t.transceiver.setParameters({
                encodings: (parameters?.encodings ?? []) as never,
                keyFrames: parameters?.keyFrames ?? [],
              })
            : Promise.resolve(),
        );
        return null;
      }
      case 'rtcEncodings': {
        // a sender's encodings, as a description or `setParameters` left
        // them in the page's realm: what its layers encode
        const t = this._transceivers.get(Number(a));
        const encodings = json(b);
        if (t && Array.isArray(encodings)) {
          t.transceiver
            .setParameters({ encodings: encodings as never })
            .catch(() => {});
          // a sender's transform hears the rids it may ask a key frame of
          for (const on of this._transforms.values()) {
            if (on.tx === Number(a) && on.side === 'sender') {
              this._seams.toWorker?.(on.worker, {
                kind: 'rtc',
                op: 'tf',
                tf: on.tf,
                e: 'rids',
                v: t.transceiver.rids?.() ?? [],
              });
            }
          }
        }
        return null;
      }
      case 'rtcOffer': {
        const peer = this._peers.get(Number(a));
        this._settle(
          Number(b),
          peer
            ? peer.connection.createOffer({ iceRestart: c === true })
            : this._gone(),
        );
        return null;
      }
      case 'rtcAnswer': {
        const peer = this._peers.get(Number(a));
        this._settle(
          Number(b),
          peer ? peer.connection.createAnswer() : this._gone(),
        );
        return null;
      }
      case 'rtcSetLocal':
      case 'rtcSetRemote': {
        const peer = this._peers.get(Number(a));
        const description = json(c) as { type?: string; sdp?: string } | null;
        if (!peer || !description) {
          this._settle(Number(b), this._gone());
          return null;
        }
        this._apply(peer, op === 'rtcSetLocal', Number(b), description);
        return null;
      }
      case 'rtcCandidate': {
        const peer = this._peers.get(Number(a));
        const candidate = c === null ? null : (json(c) as never);
        this._settle(
          Number(b),
          peer ? peer.connection.addIceCandidate(candidate) : this._gone(),
        );
        return null;
      }
      case 'rtcStats': {
        const peer = this._peers.get(Number(a));
        const selected = d !== null && d !== undefined;
        const t = selected ? this._transceivers.get(Number(d)) : null;
        const side = text(c) === 'receiver' ? 'receiver' : 'sender';
        // a closed connection's stats are what its stack has left, and a
        // sender's or a receiver's there have no stream (WebRTC 1.0, 8.2):
        // its transceivers are gone
        const work = t
          ? t.transceiver.stats(side)
          : selected
            ? Promise.resolve([])
            : peer?.closed
              ? peer.connection.stats().catch(() => [])
              : peer
                ? peer.connection.stats()
                : this._gone();
        // settled in a task of its own, as a browser settles it: a page
        // that asks again as each report comes, in a loop, would otherwise
        // never let the network in, and nothing it waits for would arrive
        this._settle(
          Number(b),
          work.then((list) => later(this._hardwareHidden(list))),
        );
        return null;
      }
      case 'rtcCertificate': {
        const seam = this._seams.webRTC() ?? NO_WEBRTC;
        const keygen = json(b) as never;
        const origin = this._seams.origin();
        this._settle(
          Number(a),
          seam.generateCertificate(keygen, Number(c)).then((made) => {
            let byId = CERTIFICATE_ORIGINS.get(seam);
            if (!byId) CERTIFICATE_ORIGINS.set(seam, (byId = new Map()));
            byId.set(made.id, { origin, owner: this });
            return made;
          }),
        );
        return null;
      }
      case 'rtcChannel':
        return this._createChannel(Number(a), json(b));
      case 'rtcChannelId': {
        const id = this._channels.get(Number(a))?.channel.id;
        return typeof id === 'number' ? id : null;
      }
      case 'rtcSend': {
        const ch = this._channels.get(Number(a));
        if (!ch) return null;
        ch.channel.send(b === true ? bytesOf(text(c)) : text(c));
        return null;
      }
      case 'rtcCloseChannel':
        this._channels.get(Number(a))?.channel.close();
        return null;
      case 'rtcTransfer': {
        // a page's channel handed to a worker: what becomes of it is the
        // worker's to hear from now on
        const id = Number(a);
        if (this._channels.has(id)) {
          this._moved.set(id, { worker: Number(b), adopted: false, held: [] });
        }
        return null;
      }
      case 'rtcAdopt':
        this._adopt(Number(a));
        return null;
      case 'rtcTransform':
        // a transform put on a side, or taken off it (`d` 0)
        this._transform(
          Number(a),
          b === 'receiver' ? 'receiver' : 'sender',
          Number(c),
          Number(d),
        );
        return null;
      case 'rtcTfAsk':
        // a worker's: of a transform of its, to the page process
        this._seams.toPage?.({
          kind: 'rtc',
          op: 'tfAsk',
          tf: Number(a),
          e: text(b),
          v: json(c),
        });
        return null;
      default:
        return null;
    }
  }

  /**
   * A worker's realm made its own of a channel the page handed it: on the
   * worker's side, its ops go to the page process, and the page process is
   * told to send on what it held.
   */
  private _adopt(id: number): void {
    const toPage = this._seams.toPage;
    if (!toPage || this._channels.has(id)) return;
    const peer = {
      id: 0,
      applying: 0,
      held: [],
      closed: false,
    } as unknown as Peer;
    this._channels.set(id, {
      id,
      peer,
      channel: {
        listen() {},
        send: (data) =>
          toPage(
            typeof data === 'string'
              ? { kind: 'rtc', op: 'send', ch: id, binary: false, data }
              : {
                  kind: 'rtc',
                  op: 'send',
                  ch: id,
                  binary: true,
                  data: base64Of(data),
                },
          ),
        close: () => toPage({ kind: 'rtc', op: 'close', ch: id }),
      },
    });
    toPage({ kind: 'rtc', op: 'adopt', ch: id });
  }

  /**
   * A transform `tf`, its worker's, is on a side of a transceiver from now
   * on, or on none (`worker` 0). A side has one transform, and a transform
   * one side: what was there before is told it is taken off.
   */
  private _transform(
    tx: number,
    side: RTCTransformSide,
    tf: number,
    worker: number,
  ): void {
    const t = this._transceivers.get(tx);
    const tell = (to: Transform, e: string, v: unknown = null) =>
      this._seams.toWorker?.(to.worker, {
        kind: 'rtc',
        op: 'tf',
        tf: to.tf,
        e,
        v,
      });
    for (const [n, on] of this._transforms) {
      if (n === tf || (on.tx === tx && on.side === side)) {
        this._transforms.delete(n);
        tell(on, 'detach');
        if (on.tx !== tx || on.side !== side) {
          this._transceivers.get(on.tx)?.transceiver.transform?.(on.side, null);
        }
      }
    }
    if (!t) return;
    if (!worker || !tf) {
      t.transceiver.transform?.(side, null);
      return;
    }
    const on: Transform = { tf, tx, side, worker };
    this._transforms.set(tf, on);
    tell(on, 'attach', {
      side,
      kind: t.transceiver.kind,
      rids: side === 'sender' ? (t.transceiver.rids?.() ?? []) : [],
    });
    t.transceiver.transform?.(side, (frame) => {
      if (this._transforms.get(tf) === on) tell(on, 'frame', frameWire(frame));
    });
  }

  /** What a worker asked of a transform of its. */
  private _transformAsked(worker: number, tf: number, e: string, v: unknown) {
    const on = this._transforms.get(tf);
    if (!on || on.worker !== worker) return;
    const t = this._transceivers.get(on.tx)?.transceiver;
    if (!t) return;
    if (e === 'write') {
      const frame = frameOfWire(v);
      if (frame) t.writeFrame?.(on.side, frame);
    } else if (e === 'key') {
      t.keyFrame?.(typeof v === 'string' ? v : null);
    } else if (e === 'pli') {
      void (t.requestKeyFrame?.() ?? Promise.resolve())
        .catch(() => {})
        .then(() =>
          this._seams.toWorker?.(worker, {
            kind: 'rtc',
            op: 'tf',
            tf,
            e: 'settled',
            v,
          }),
        );
    }
  }

  /** What a worker asked of a channel the page handed it. */
  fromWorker(worker: number, m: ChannelRelay): void {
    if (m.op === 'tfAsk') {
      this._transformAsked(worker, m.tf, m.e, m.v);
      return;
    }
    if (m.op === 'tf') return;
    const moved = this._moved.get(m.ch);
    if (!moved || moved.worker !== worker) return;
    if (m.op === 'adopt') {
      moved.adopted = true;
      for (const held of moved.held.splice(0)) {
        this._seams.toWorker?.(worker, held);
        if (held.op === 'event' && held.k === 'closed') {
          this._moved.delete(m.ch);
        }
      }
    } else if (m.op === 'send') {
      this._channels
        .get(m.ch)
        ?.channel.send(m.binary ? bytesOf(m.data) : m.data);
    } else if (m.op === 'close') {
      this._channels.get(m.ch)?.channel.close();
    }
  }

  /** What became of a channel this worker was handed: told to its realm. */
  heard(m: ChannelRelay): void {
    if (m.op === 'event') this._tell('__rtcChannel', [m.ch, m.k, m.v]);
    else if (m.op === 'tf') this._tell('__rtcTf', [m.tf, m.e, m.v]);
  }

  /** The realm goes: every connection it had is closed. */
  dispose(): void {
    this._disposed = true;
    for (const peer of this._peers.values()) this._close(peer);
    this._peers.clear();
    this._transceivers.clear();
    this._channels.clear();
  }

  /**
   * What an RTP stream's stats say of the hardware that codes it is said
   * only while the document captures from a camera or a microphone
   * (WebRTC Statistics, 14.1, "limiting exposure of hardware
   * capabilities"), as every browser has it: what a fingerprinter learns
   * from the encoder's name it learns only from a page the user let see
   * them.
   */
  private _hardwareHidden(list: RTCStatsLike[]): RTCStatsLike[] {
    if (this._seams.sources().capturing()) return list;
    for (const s of list) {
      if (s.type !== 'outbound-rtp' && s.type !== 'inbound-rtp') continue;
      for (const field of HARDWARE_FIELDS) delete s[field];
    }
    return list;
  }

  private _gone(): Promise<never> {
    return Promise.reject({
      name: 'InvalidStateError',
      message: 'The connection is closed.',
    });
  }

  private _tell(entry: string, input: unknown): void {
    if (!this._disposed) this._seams.tell(entry, input);
  }

  /** What a connection tells, held while a description is applied. */
  private _event(peer: Peer, entry: string, input: unknown): void {
    if (peer.closed) return;
    if (peer.applying > 0) peer.held.push([entry, input]);
    else this._tell(entry, input);
  }

  private _settle(req: number, work: Promise<unknown>): void {
    work.then(
      (value) => this._tell('__rtcSettled', [req, true, value ?? null]),
      (error) => this._tell('__rtcSettled', [req, false, errorOf(error)]),
    );
  }

  private _open(id: number, request: RTCConnectRequest | null): void {
    const seam = this._seams.webRTC() ?? NO_WEBRTC;
    const full: RTCConnectRequest = {
      iceServers: request?.iceServers ?? [],
      iceTransportPolicy: request?.iceTransportPolicy ?? 'all',
      bundlePolicy: request?.bundlePolicy ?? 'balanced',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: request?.iceCandidatePoolSize ?? 0,
      alwaysNegotiateDataChannels:
        request?.alwaysNegotiateDataChannels === true,
      // a certificate this origin made, and no other's
      certificates: (request?.certificates ?? []).filter((id) => {
        const made = CERTIFICATE_ORIGINS.get(seam)?.get(id);
        const origin = this._seams.origin();
        return (
          made !== undefined &&
          (made.owner === this ||
            (made.origin !== 'null' && made.origin === origin))
        );
      }),
      origin: this._seams.origin(),
    };
    const peer = {
      id,
      applying: 0,
      held: [],
      closed: false,
    } as unknown as Peer;
    this._peers.set(id, peer);
    // a seam that throws is one that makes no connection: every operation
    // is refused, as with no stack
    const connect = (events: Parameters<HtmlWebRTC['connect']>[1]) => {
      try {
        return seam.connect(full, events);
      } catch {
        return NO_WEBRTC.connect(full, events);
      }
    };
    peer.connection = connect({
      candidate: (transport, candidate) =>
        this._event(peer, '__rtcCandidate', [id, transport, candidate]),
      candidateError: (error) =>
        this._event(peer, '__rtcCandidateError', [id, error]),
      transport: (transport, state) =>
        this._event(peer, '__rtcTransport', [
          id,
          transport,
          transportOf(state),
        ]),
      sctp: (state) => this._event(peer, '__rtcSctp', [id, state]),
      dataChannel: (channel, init) => {
        if (peer.closed) return;
        // the page hears of the channel before anything of what it does
        this._channel(peer, channel, (ch) =>
          this._event(peer, '__rtcDataChannel', [id, ch, init]),
        );
      },
    });
  }

  private _close(peer: Peer): void {
    if (peer.closed) return;
    peer.closed = true;
    peer.held = [];
    try {
      peer.connection.close();
    } catch {}
    for (const [id, t] of this._transceivers) {
      if (t.peer === peer) this._transceivers.delete(id);
    }
    for (const [id, ch] of this._channels) {
      if (ch.peer === peer) this._channels.delete(id);
    }
  }

  /** A transceiver's number, made as it is first seen, with its
   *  receiver's source. */
  private _transceiver(
    peer: Peer,
    transceiver: RTCTransceiverLike,
  ): Transceiver {
    const known = this._ids.get(transceiver);
    if (known !== undefined) return this._transceivers.get(known)!;
    const t: Transceiver = {
      id: ++this._seq,
      peer,
      transceiver,
      source: this._seams.sources().register(transceiver.received),
      sending: null,
    };
    this._ids.set(transceiver, t.id);
    this._transceivers.set(t.id, t);
    return t;
  }

  private _addTransceiver(pc: number, init: unknown): Primitive {
    const peer = this._peers.get(pc);
    if (!peer || peer.closed || !init || typeof init !== 'object') return null;
    const i = init as {
      kind?: string;
      direction?: string;
      source?: number;
      trackId?: string | null;
      output?: string;
      streams?: string[];
      sendEncodings?: unknown[];
      addTrack?: boolean;
    };
    const kind = i.kind === 'video' ? 'video' : 'audio';
    const source =
      typeof i.source === 'number' && i.source >= 0
        ? this._seams.sources().tap(i.source, outputOf(i.output))
        : null;
    const transceiver = peer.connection.addTransceiver({
      kind,
      direction: (i.direction ?? 'sendrecv') as never,
      source,
      trackId: source ? (i.trackId ?? null) : null,
      streams: (i.streams ?? []).map(String),
      sendEncodings: (i.sendEncodings ?? []) as never,
      addTrack: i.addTrack === true,
    });
    const t = this._transceiver(peer, transceiver);
    t.sending = source;
    return JSON.stringify({ id: t.id, source: t.source });
  }

  /** A session state as it crosses to the page. */
  private _stateOf(peer: Peer, state: RTCSessionState): unknown {
    return {
      transceivers: state.transceivers.map((s) => {
        const t = this._transceiver(peer, s.transceiver);
        return {
          id: t.id,
          kind: s.transceiver.kind,
          source: t.source,
          mid: s.mid,
          direction: s.direction,
          currentDirection: s.currentDirection,
          remoteDirection: s.remoteDirection,
          stopped: s.stopped,
          sender: s.sender,
          receiver: s.receiver,
          headerExtensions: s.headerExtensions,
        };
      }),
      sctp: state.sctp
        ? {
            ...state.sctp,
            maxMessageSize: Number.isFinite(state.sctp.maxMessageSize)
              ? state.sctp.maxMessageSize
              : 0,
          }
        : null,
    };
  }

  private _apply(
    peer: Peer,
    local: boolean,
    req: number,
    description: { type?: string; sdp?: string },
  ): void {
    const type = description.type as
      'offer' | 'answer' | 'pranswer' | 'rollback';
    const sdp = String(description.sdp ?? '');
    peer.applying += 1;
    const work = local
      ? peer.connection.setLocalDescription(type, sdp)
      : peer.connection.setRemoteDescription(type, sdp);
    const release = () => {
      peer.applying -= 1;
      if (peer.applying > 0) return;
      for (const [entry, input] of peer.held.splice(0))
        this._tell(entry, input);
    };
    work.then(
      (state) => {
        if (peer.closed) return;
        this._tell('__rtcSettled', [req, true, this._stateOf(peer, state)]);
        release();
      },
      (error) => {
        this._tell('__rtcSettled', [req, false, errorOf(error)]);
        release();
      },
    );
  }

  private _createChannel(pc: number, init: unknown): Primitive {
    const peer = this._peers.get(pc);
    if (!peer || peer.closed || !init || typeof init !== 'object') return null;
    const channel = peer.connection.createDataChannel(init as never);
    return this._channel(peer, channel);
  }

  /**
   * A channel's number, made as it is first seen, and listened to: after
   * `announce`, where the page has to be told of it first, and once the op
   * that made it has answered, where the page made it. A negotiated channel
   * made once SCTP is up is open as it is made, and the page knows the
   * channel by its number only from the op's answer.
   */
  private _channel(
    peer: Peer,
    channel: RTCDataChannelLike,
    announce?: (id: number) => void,
  ): number {
    const id = ++this._seq;
    this._channels.set(id, { id, peer, channel });
    if (announce) {
      announce(id);
      this._listen(peer, id, channel);
    } else {
      queueMicrotask(() => {
        if (!peer.closed) this._listen(peer, id, channel);
      });
    }
    return id;
  }

  private _listen(peer: Peer, id: number, channel: RTCDataChannelLike): void {
    const tell = (kind: string, value?: unknown) => {
      const moved = this._moved.get(id);
      if (!moved) {
        this._event(peer, '__rtcChannel', [id, kind, value ?? null]);
        return;
      }
      // a channel handed to a worker: told there, once it has made its own
      const m: ChannelRelay = {
        kind: 'rtc',
        op: 'event',
        ch: id,
        k: kind,
        v: value ?? null,
      };
      if (moved.adopted) {
        this._seams.toWorker?.(moved.worker, m);
        if (kind === 'closed') this._moved.delete(id);
      } else moved.held.push(m);
    };
    channel.listen({
      id: (n) => tell('id', n),
      open: () => tell('open'),
      message: (data) =>
        typeof data === 'string'
          ? tell('message', data)
          : tell('binary', base64Of(data)),
      sent: (bytes) => tell('sent', bytes),
      closing: () => tell('closing'),
      closed: () => {
        tell('closed');
        this._channels.delete(id);
      },
      error: (error) => tell('error', error),
    });
  }
}

/** A transport's state as it crosses: its certificates as base64. */
function transportOf(state: RTCTransportStateLike): unknown {
  return {
    ...state,
    remoteCertificates: state.remoteCertificates.map(base64Of),
  };
}
