// A WebRTC stack that connects nothing: an `HtmlWebRTC` (src/html/rtc.ts)
// that writes and reads SDP as far as an offer, an answer and their
// directions go, gathers one host candidate per transport, and connects two
// of its own connections the moment both descriptions are in. CI runs no
// werift on Node 20, so it is how the page's `RTCPeerConnection` — the
// operations chain, the signalling state, the events and their order — is
// held to WebRTC 1.0 on every runtime; `webrtc-werift.test.ts` holds the
// adapter.
import { idleSource } from '../src/html/media-devices.js';
import type { MediaSourceLike } from '../src/html/media-devices.js';
import { offeredCapabilities } from '../src/html/rtc-codecs.js';
import type {
  HtmlWebRTC,
  RTCCandidateLike,
  RTCConnectRequest,
  RTCConnectionEvents,
  RTCConnectionLike,
  RTCDataChannelEvents,
  RTCDataChannelInitLike,
  RTCDataChannelLike,
  RTCDescriptionsLike,
  RTCDirectionLike,
  RTCSessionState,
  RTCTransceiverInit,
  RTCTransceiverLike,
  RTCTransportStateLike,
} from '../src/html/rtc.js';

type Direction = Exclude<RTCDirectionLike, 'stopped'>;

interface Section {
  kind: string;
  mid: string;
  port: number;
  direction: Direction;
  streams: string[];
}

function sectionsOf(sdp: string | null): Section[] {
  const out: Section[] = [];
  for (const line of (sdp ?? '').split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      const [kind, port] = line.slice(2).split(' ');
      out.push({
        kind,
        mid: '',
        port: Number(port),
        direction: 'sendrecv',
        streams: [],
      });
    } else if (out.length && line.startsWith('a=mid:')) {
      out[out.length - 1].mid = line.slice(6);
    } else if (
      out.length &&
      /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)
    ) {
      out[out.length - 1].direction = line.slice(2) as Direction;
    } else if (out.length && line.startsWith('a=msid:')) {
      const stream = line.slice(7).split(' ')[0];
      if (stream !== '-') out[out.length - 1].streams.push(stream);
    }
  }
  return out;
}

const reversed = (d: Direction): Direction =>
  d === 'sendonly' ? 'recvonly' : d === 'recvonly' ? 'sendonly' : d;
const sends = (d: string) => d === 'sendrecv' || d === 'sendonly';
const receives = (d: string) => d === 'sendrecv' || d === 'recvonly';
const intersect = (mine: Direction, offered: Direction): Direction => {
  const s = sends(mine) && receives(offered);
  const r = receives(mine) && sends(offered);
  return s && r ? 'sendrecv' : s ? 'sendonly' : r ? 'recvonly' : 'inactive';
};

export class FakeTransceiver implements RTCTransceiverLike {
  readonly received: MediaSourceLike;
  mid: string | null = null;
  currentDirection: RTCDirectionLike | null = null;
  stopping = false;
  stopped = false;
  streams: string[];
  trackId: string | null;
  /** Made by a remote offer that may still be rolled back. */
  fromRemote = false;
  remoteDirection: Direction | null = null;
  remoteStreams: string[] = [];
  constructor(
    readonly kind: 'audio' | 'video',
    public direction: Direction,
    streams: string[],
    trackId: string | null,
  ) {
    this.received = idleSource(kind);
    this.streams = streams;
    this.trackId = trackId;
  }
  setTrack(_source: MediaSourceLike | null, trackId: string | null): void {
    this.trackId = trackId;
  }
  setDirection(direction: Direction): void {
    this.direction = direction;
  }
  setStreams(ids: string[]): void {
    this.streams = ids;
  }
  setCodecPreferences(): void {}
  setHeaderExtensionsToNegotiate(): void {}
  setParameters(): Promise<void> {
    return Promise.resolve();
  }
  stop(): void {
    this.stopping = true;
  }
  sources() {
    return [];
  }
  setJitterBufferTarget(): void {}
  sendTone(): boolean {
    return false;
  }
  stats() {
    return Promise.resolve([]);
  }
}

class FakeChannel implements RTCDataChannelLike {
  events: RTCDataChannelEvents | null = null;
  sent: (string | Uint8Array)[] = [];
  constructor(readonly init: RTCDataChannelInitLike) {}
  listen(events: RTCDataChannelEvents): void {
    this.events = events;
    // a negotiated channel is open as soon as it is made, as one made once
    // the association is up is; a channel the fake would announce is not
    if (this.init.negotiated) {
      if (this.init.id !== null) events.id(this.init.id);
      events.open();
    }
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    // as a stack does, after the page's call: the stream is reset, and
    // its close told once it has been
    queueMicrotask(() => {
      this.events?.closing();
      this.events?.closed();
    });
  }
}

/** One connection of the fake stack. */
export class FakeConnection implements RTCConnectionLike {
  transceivers: FakeTransceiver[] = [];
  channels: FakeChannel[] = [];
  descriptions_: RTCDescriptionsLike = {
    currentLocal: null,
    pendingLocal: null,
    currentRemote: null,
    pendingRemote: null,
  };
  candidates: (RTCCandidateLike | null)[] = [];
  closed = false;
  private _mid = 0;
  private _ufrag = Math.random().toString(36).slice(2, 6);
  private _gathered = false;
  private _transport: RTCTransportStateLike = {
    iceState: 'new',
    gatheringState: 'new',
    role: 'unknown',
    dtlsState: 'new',
    remoteCertificates: [],
    selectedPair: null,
    localParameters: null,
    remoteParameters: null,
  };

  constructor(
    readonly stack: FakeWebRTC,
    readonly request: RTCConnectRequest,
    readonly events: RTCConnectionEvents,
  ) {}

  addTransceiver(init: RTCTransceiverInit): RTCTransceiverLike {
    const t = new FakeTransceiver(
      init.kind,
      init.direction,
      init.streams,
      init.trackId,
    );
    this.transceivers.push(t);
    return t;
  }

  private _write(type: 'offer' | 'answer'): string {
    const lines = ['v=0', 'o=- 1 1 IN IP4 0.0.0.0', 's=-', 't=0 0'];
    const remote = sectionsOf(this.descriptions_.pendingRemote);
    const live = this.transceivers.filter((t) => !t.stopped);
    const order =
      type === 'answer'
        ? remote.map((s) => ({ s, t: live.find((t) => t.mid === s.mid) }))
        : live.map((t) => ({ s: null as Section | null, t }));
    lines.push(
      `a=group:BUNDLE ${order.map(({ s, t }) => t?.mid ?? s?.mid ?? '').join(' ')}`.trimEnd(),
    );
    lines.push(
      `a=ice-ufrag:${this._ufrag}`,
      'a=ice-pwd:fakefakefakefakefakefake',
    );
    lines.push('a=ice-options:trickle');
    let n = this._mid;
    for (const { s, t } of order) {
      if (!t) continue;
      const mid = t.mid ?? String(n++);
      const port = t.stopping ? 0 : 9;
      lines.push(`m=${t.kind} ${port} UDP/TLS/RTP/SAVPF 111`, `a=mid:${mid}`);
      const direction =
        type === 'answer' && s
          ? intersect(t.direction, s.direction)
          : t.direction;
      lines.push(`a=${t.stopping ? 'inactive' : direction}`);
      if (sends(direction)) {
        for (const stream of t.streams) {
          lines.push(`a=msid:${stream} ${t.trackId ?? 'track'}`);
        }
      }
    }
    const app =
      type === 'answer'
        ? remote.some((s) => s.kind === 'application')
        : this.channels.length > 0 ||
          sectionsOf(this.descriptions_.currentLocal).some(
            (s) => s.kind === 'application',
          );
    if (app) {
      lines.push('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
      lines.push(
        `a=mid:${type === 'answer' ? remote.find((s) => s.kind === 'application')!.mid : 'data'}`,
      );
      lines.push('a=sctp-port:5000', 'a=max-message-size:262144');
    }
    return lines.join('\r\n') + '\r\n';
  }

  async createOffer(): Promise<string> {
    return this._write('offer');
  }
  async createAnswer(): Promise<string> {
    return this._write('answer');
  }

  private _state(): RTCSessionState {
    return {
      transceivers: this.transceivers.map((t) => ({
        transceiver: t,
        mid: t.mid,
        direction: t.stopping ? 'stopped' : t.direction,
        currentDirection: t.currentDirection,
        remoteDirection: t.remoteDirection,
        stopped: t.stopped,
        sender: {
          transport: t.mid !== null ? 1 : null,
          // what a stack answers once a description gave the transceiver
          // an m-section, an offer's too: the page's realm takes it from
          // an answer only
          parameters: {
            codecs:
              t.mid !== null
                ? [
                    {
                      payloadType: 111,
                      mimeType: 'audio/opus',
                      clockRate: 48000,
                      channels: 2,
                      sdpFmtpLine: 'minptime=10;useinbandfec=1',
                    },
                  ]
                : [],
            headerExtensions: [],
            rtcp: { cname: 'fake', reducedSize: true },
          },
        },
        receiver: {
          transport: t.mid !== null ? 1 : null,
          parameters: {
            codecs: [],
            headerExtensions: [],
            rtcp: { cname: 'fake', reducedSize: true },
          },
          streams:
            t.remoteDirection && sends(t.remoteDirection)
              ? t.remoteStreams
              : [],
        },
        headerExtensions: [],
      })),
      sctp: sectionsOf(
        this.descriptions_.pendingLocal ?? this.descriptions_.currentLocal,
      ).some((s) => s.kind === 'application')
        ? { transport: 1, maxMessageSize: 262144, maxChannels: null }
        : null,
    };
  }

  private _tellTransport(next: Partial<RTCTransportStateLike>): void {
    this._transport = { ...this._transport, ...next };
    this.events.transport(1, this._transport);
  }

  /** One host candidate, then the end of them, a task after the first
   *  local description. */
  private _gather(): void {
    if (this._gathered) return;
    this._gathered = true;
    setTimeout(() => {
      if (this.closed) return;
      this._tellTransport({
        gatheringState: 'gathering',
        localParameters: {
          usernameFragment: this._ufrag,
          password: 'fakefakefakefakefakefake',
        },
      });
      this.events.candidate(1, {
        candidate: `candidate:1 1 udp 2122260223 192.0.2.1 ${40000 + this.stack.connections.indexOf(this)} typ host`,
        sdpMid: this.transceivers.find((t) => t.mid !== null)?.mid ?? 'data',
        sdpMLineIndex: 0,
        usernameFragment: this._ufrag,
      });
      setTimeout(() => {
        if (!this.closed) this._tellTransport({ gatheringState: 'complete' });
      }, 0);
    }, 0);
  }

  /** Connected, a task after both descriptions are in. */
  private _connectSoon(): void {
    setTimeout(() => {
      if (this.closed) return;
      this._tellTransport({ iceState: 'checking', dtlsState: 'new' });
      setTimeout(() => {
        if (this.closed) return;
        this._tellTransport({
          iceState: 'connected',
          dtlsState: 'connecting',
          role: 'controlling',
        });
        setTimeout(() => {
          if (!this.closed) this._tellTransport({ dtlsState: 'connected' });
        }, 0);
      }, 0);
    }, 0);
  }

  async setLocalDescription(
    type: 'offer' | 'answer' | 'pranswer' | 'rollback',
    sdp: string,
  ): Promise<RTCSessionState> {
    const d = this.descriptions_;
    if (type === 'rollback') {
      d.pendingLocal = null;
      for (const t of this.transceivers) if (!t.currentDirection) t.mid = null;
      return this._state();
    }
    const sections = sectionsOf(sdp);
    if (type === 'offer') {
      d.pendingLocal = sdp;
      const live = this.transceivers.filter((t) => !t.stopped);
      sections
        .filter((s) => s.kind !== 'application')
        .forEach((s, i) => {
          const t = live[i];
          if (t && t.mid === null) t.mid = s.mid;
        });
      this._mid = Math.max(
        this._mid,
        ...sections.map((s) => Number(s.mid) + 1).filter(Number.isFinite),
      );
    } else {
      d.currentLocal = sdp;
      d.currentRemote = d.pendingRemote;
      d.pendingLocal = null;
      d.pendingRemote = null;
      for (const s of sections) {
        const t = this.transceivers.find((x) => x.mid === s.mid);
        if (!t) continue;
        t.fromRemote = false;
        if (s.port === 0) {
          t.stopped = true;
          t.currentDirection = 'stopped';
        } else t.currentDirection = s.direction;
      }
      this._connectSoon();
    }
    this._gather();
    return this._state();
  }

  async setRemoteDescription(
    type: 'offer' | 'answer' | 'pranswer' | 'rollback',
    sdp: string,
  ): Promise<RTCSessionState> {
    const d = this.descriptions_;
    if (type === 'rollback') {
      d.pendingRemote = null;
      this.transceivers = this.transceivers.filter((t) => !t.fromRemote);
      return this._state();
    }
    const sections = sectionsOf(sdp);
    if (type === 'offer') {
      d.pendingRemote = sdp;
      for (const s of sections) {
        if (s.kind === 'application') continue;
        let t = this.transceivers.find((x) => x.mid === s.mid);
        if (!t) {
          t = new FakeTransceiver(
            s.kind as 'audio' | 'video',
            'recvonly',
            [],
            null,
          );
          t.mid = s.mid;
          t.fromRemote = true;
          this.transceivers.push(t);
        }
        t.remoteDirection = s.direction;
        t.remoteStreams = s.streams;
        // a rejected m-section stops its transceiver (WebRTC 1.0, 4.4.1.6)
        if (s.port === 0) t.stopping = true;
      }
    } else {
      d.currentRemote = sdp;
      d.currentLocal = d.pendingLocal;
      d.pendingLocal = null;
      d.pendingRemote = null;
      for (const s of sections) {
        const t = this.transceivers.find((x) => x.mid === s.mid);
        if (!t) continue;
        t.remoteDirection = s.direction;
        t.remoteStreams = s.streams;
        if (s.port === 0 || t.stopping) {
          t.stopped = true;
          t.currentDirection = 'stopped';
        } else t.currentDirection = reversed(s.direction);
      }
      this._connectSoon();
    }
    return this._state();
  }

  async addIceCandidate(candidate: RTCCandidateLike | null): Promise<void> {
    this.candidates.push(candidate);
  }
  restartIce(): void {
    this._ufrag = Math.random().toString(36).slice(2, 6);
  }
  setConfiguration(): void {}
  descriptions(): RTCDescriptionsLike {
    return { ...this.descriptions_ };
  }
  createDataChannel(init: RTCDataChannelInitLike): RTCDataChannelLike {
    const ch = new FakeChannel(init);
    this.channels.push(ch);
    return ch;
  }
  async stats() {
    return [{ id: 'P', type: 'peer-connection', timestamp: 0 }];
  }
  close(): void {
    this.closed = true;
  }
}

/** The fake stack: every connection it made, in order. */
export class FakeWebRTC implements HtmlWebRTC {
  connections: FakeConnection[] = [];
  private _certificates = 0;
  connect(
    request: RTCConnectRequest,
    events: RTCConnectionEvents,
  ): RTCConnectionLike {
    const c = new FakeConnection(this, request, events);
    this.connections.push(c);
    return c;
  }
  async generateCertificate(_keygen: unknown, expires: number) {
    return {
      id: ++this._certificates,
      expires,
      fingerprints: [{ algorithm: 'sha-256', value: 'AB:CD:EF' }],
    };
  }
  capabilities(kind: 'audio' | 'video') {
    return offeredCapabilities(kind);
  }
}
