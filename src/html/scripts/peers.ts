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
  RTCSessionState,
  RTCTransceiverLike,
  RTCTransportStateLike,
} from '../rtc.js';
import type { PageSources } from './media-sources.js';
import type { BufferClass } from './platform.js';

declare const Buffer: BufferClass;
declare const queueMicrotask: (fn: () => void) => void;

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
  | { kind: 'rtc'; op: 'event'; ch: number; k: string; v: unknown };

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
}

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

export class PagePeers {
  private readonly _peers = new Map<number, Peer>();
  private readonly _transceivers = new Map<number, Transceiver>();
  private readonly _ids = new Map<RTCTransceiverLike, number>();
  private readonly _channels = new Map<number, Channel>();
  /** The page's channels handed to a worker, by number. */
  private readonly _moved = new Map<number, Moved>();
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
      case 'rtcStreams': {
        const ids = json(b);
        this._transceivers
          .get(Number(a))
          ?.transceiver.setStreams(Array.isArray(ids) ? ids.map(String) : []);
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
        const source =
          Number(b) >= 0 ? this._seams.sources().get(Number(b)) : null;
        t.transceiver.setTrack(source, source ? text(c) || null : null);
        return null;
      }
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
        const parameters = json(c) as { encodings?: unknown[] } | null;
        this._settle(
          Number(b),
          t
            ? t.transceiver.setParameters({
                encodings: (parameters?.encodings ?? []) as never,
              })
            : Promise.resolve(),
        );
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
        const t =
          d === null || d === undefined
            ? null
            : this._transceivers.get(Number(d));
        const side = text(c) === 'receiver' ? 'receiver' : 'sender';
        this._settle(
          Number(b),
          t
            ? t.transceiver.stats(side)
            : peer
              ? peer.connection.stats()
              : this._gone(),
        );
        return null;
      }
      case 'rtcCertificate': {
        const seam = this._seams.webRTC() ?? NO_WEBRTC;
        const keygen = json(b) as never;
        this._settle(Number(a), seam.generateCertificate(keygen, Number(c)));
        return null;
      }
      case 'rtcChannel':
        return this._createChannel(Number(a), json(b));
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

  /** What a worker asked of a channel the page handed it. */
  fromWorker(worker: number, m: ChannelRelay): void {
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
  }

  /** The realm goes: every connection it had is closed. */
  dispose(): void {
    this._disposed = true;
    for (const peer of this._peers.values()) this._close(peer);
    this._peers.clear();
    this._transceivers.clear();
    this._channels.clear();
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
      certificates: request?.certificates ?? [],
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
      streams?: string[];
      sendEncodings?: unknown[];
    };
    const kind = i.kind === 'video' ? 'video' : 'audio';
    const source =
      typeof i.source === 'number' && i.source >= 0
        ? this._seams.sources().get(i.source)
        : null;
    const transceiver = peer.connection.addTransceiver({
      kind,
      direction: (i.direction ?? 'sendrecv') as never,
      source,
      trackId: source ? (i.trackId ?? null) : null,
      streams: (i.streams ?? []).map(String),
      sendEncodings: (i.sendEncodings ?? []) as never,
    });
    const t = this._transceiver(peer, transceiver);
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
