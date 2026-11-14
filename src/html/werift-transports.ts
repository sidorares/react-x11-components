// What a werift connection's transports and data channels tell, as the
// `HtmlWebRTC` seam has it (`./rtc.ts`): its candidates, each transport's
// state told whole whenever any of it changes, the data channels the peer
// opens and the ones the page does, and its stats. `./werift.ts` makes the
// connection and keeps its descriptions and transceivers; this is the part
// of it under them.
//
// werift's types here are written out structurally, as `./werift.ts`'s
// are, so an app that did not install it still type-checks.

import type {
  RTCCandidateLike,
  RTCConnectionEvents,
  RTCDataChannelEvents,
  RTCDataChannelInitLike,
  RTCDataChannelLike,
  RTCStatsLike,
  RTCTransportStateLike,
} from './rtc.js';

declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const queueMicrotask: (fn: () => void) => void;
declare const atob: (data: string) => string;
declare const Buffer: {
  from(bytes: Uint8Array): Uint8Array;
};
declare const TextEncoder: new () => { encode(text: string): Uint8Array };

// --- werift's shape, the slice read here ------------------------------------

export interface WEvent<A extends unknown[]> {
  subscribe(fn: (...args: A) => void): unknown;
}

export interface WCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface WIce {
  readonly state: string;
  readonly role: string;
  readonly gatheringState: string;
  readonly onStateChange: WEvent<[string]>;
  getSelectedCandidatePair(): { local: WCandidate; remote: WCandidate } | null;
  getLocalParameters(): { usernameFragment: string; password: string };
  getRemoteParameters(): { usernameFragment: string; password: string } | null;
  /** What gathers for it, and the peer's candidates it checks, a
   *  peer-reflexive one among them, which `getRemoteCandidates()` leaves
   *  out; and the pair it nominated, with what it has heard on it. */
  readonly connection?: {
    remoteCandidates?: unknown[];
    nominated?: WHeardPair;
  };
  /** The peer's candidates it has, but those it found as peer-reflexive. */
  getRemoteCandidates?(): unknown[];
  /** Its own candidates as it tells them, and undefined after the last of
   *  a generation. */
  readonly onIceCandidate?: WEvent<[WCandidate | undefined]>;
}

/** A candidate pair's counts of what came in on it, werift's `CandidatePair`. */
export interface WHeardPair {
  readonly id: string;
  readonly packetsReceived: number;
  readonly requestsReceived: number;
  readonly responsesReceived: number;
}

export interface WDtls {
  /** What its stats are named by: `transport_<id>`. */
  readonly id: string;
  readonly state: string;
  readonly iceTransport: WIce;
  readonly onStateChange: WEvent<[string]>;
  /** Its DTLS session, once there is one: the peer's certificate, DER. */
  readonly dtls?: { readonly remoteCertificate?: Uint8Array };
}

/** A transport's SCTP association: werift makes one for each DTLS
 *  transport it runs data channels over. */
export interface WAssociation {
  readonly stateChanged: { connected: WEvent<[]>; closed: WEvent<[]> };
  /** 4 is ESTABLISHED. */
  readonly associationState: number;
  /** The streams it can carry each way, once it is up. */
  readonly maxChannels?: number;
}

/** A transport's SCTP association: werift makes one for each DTLS
 *  transport it runs data channels over. */
export interface WAssociation {
  readonly stateChanged: { connected: WEvent<[]>; closed: WEvent<[]> };
  /** 4 is ESTABLISHED. */
  readonly associationState: number;
  /** The streams it can carry each way, once it is up. */
  readonly maxChannels?: number;
  /** Told as each transmission ends, which a SACK starts. */
  readonly flush?: WEvent<[]>;
}

/** One of werift's queues: an array to 0.25, and from 0.26 a `FifoQueue`
 *  of its own, which has none of an array's methods but `push`, and
 *  iterates from its head. */
interface WFifo<T> extends Iterable<T> {
  push(...items: T[]): unknown;
}

/** What an empty message is queued on: werift's own send queue, a private
 *  of its `RTCSctpTransport`'s (see `sendEmpty`). */
interface WQueue {
  dataChannelQueue?: WFifo<[WChannel, number, Uint8Array]>;
  /** Async to 0.25, and from 0.26 one pass that returns nothing. */
  dataChannelFlush?(): Promise<void> | void;
}

export interface WSctp extends WQueue {
  readonly dtlsTransport?: WDtls;
  readonly sctp?: WAssociation;
  /** The remote's `a=max-message-size`, 0 for none. */
  readonly remoteMaxMessageSize?: number;
}

export interface WChannel {
  readonly id?: number | null;
  readonly readyState: string;
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readonly protocol: string;
  readonly negotiated: boolean;
  /** What was sent and has not been handed to SCTP yet. */
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  readonly bufferedAmountLow: WEvent<[]>;
  addBufferedAmount(amount: number): void;
  /** What its stats count as sent (WebRTC Statistics, 5.9). */
  messagesSent?: number;
  /** What its stats count as received. */
  bytesReceived?: number;
  readonly stateChanged: WEvent<[string]>;
  readonly onMessage: WEvent<[string | Uint8Array]>;
  readonly error: WEvent<[Error]>;
  send(data: string | Uint8Array): void;
  close(): void;
}

/** What of a werift `RTCPeerConnection` its transports are read from. */
export interface WTransportsPeer {
  readonly onIceCandidate: WEvent<[WCandidate | undefined]>;
  readonly onDataChannel: WEvent<[WChannel]>;
  readonly iceGatheringStateChange: WEvent<[string]>;
  readonly iceConnectionStateChange: WEvent<[string]>;
  readonly connectionStateChange: WEvent<[string]>;
  readonly dtlsTransports: WDtls[];
  readonly sctpTransport?: WSctp;
  getTransceivers(): { readonly mid: string | null; dtlsTransport?: WDtls }[];
  createDataChannel(label: string, options: Record<string, unknown>): WChannel;
  getStats(): Promise<{ values(): Iterable<Record<string, unknown>> }>;
  readonly pendingLocalDescription: { type: string } | null;
  readonly pendingRemoteDescription: { type: string } | null;
}

export function candidateOf(c: WCandidate): RTCCandidateLike {
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

// --- data channels ----------------------------------------------------------

/** One of a connection's data channels. */
class WeriftChannel implements RTCDataChannelLike {
  private _events: RTCDataChannelEvents | null = null;
  private _told = 'connecting';
  private _idTold = false;
  /** The page closed it. */
  private _closing = false;
  /** What arrived before anything listened. */
  private readonly _early: (string | Uint8Array)[] = [];

  constructor(
    private readonly _ch: WChannel,
    /** What is told before it is told open: its association's state. */
    private readonly _beforeOpen: () => void,
    /** The SCTP transport it is sent over. */
    private readonly _sctp: () => WSctp | undefined,
  ) {
    _ch.stateChanged.subscribe((state) => this._state(state));
    _ch.onMessage.subscribe((data) => {
      const message = typeof data === 'string' ? data : new Uint8Array(data);
      // werift counts an empty message's one byte of padding (RFC 8831,
      // 6.6) as a byte received, where the message had none
      if (
        (typeof message === 'string' ? message === '' : !message.byteLength) &&
        typeof this._ch.bytesReceived === 'number' &&
        this._ch.bytesReceived > 0
      ) {
        this._ch.bytesReceived -= 1;
      }
      // what comes before the page listens, which a channel the far side
      // opened is told a microtask late, is held for it
      if (!this._events) {
        this._early.push(message);
        return;
      }
      // a message that comes before the peer's DATA_CHANNEL_ACK is the
      // ACK (RFC 8832, 6): werift hands it on while its channel still says
      // connecting, and a page drops what reaches a channel not yet open
      if (this._told === 'connecting') this._state('open');
      this._events.message(message);
    });
    _ch.error.subscribe((error) =>
      this._events?.error({
        errorDetail: 'data-channel-failure',
        sctpCauseCode: null,
        message: String(error?.message ?? error),
      }),
    );
  }

  get id(): number | null {
    return typeof this._ch.id === 'number' ? this._ch.id : null;
  }

  /** Tells the page the id werift gave the channel, once it has one. */
  tellId(): void {
    if (!this._events || this._idTold || typeof this._ch.id !== 'number') {
      return;
    }
    this._idTold = true;
    this._events.id(this._ch.id);
  }

  private _state(state: string): void {
    const events = this._events;
    if (!events) return;
    this.tellId();
    if (state === this._told) return;
    // a channel that was open and closed with no closing was closed by its
    // association going, not by either side's close: an error, then the
    // end (WebRTC 1.0, 6.2, "the transport closed with an error")
    if (state === 'closed' && this._told === 'open' && !this._closing) {
      events.error({
        errorDetail: 'sctp-failure',
        sctpCauseCode: null,
        message: 'The SCTP association closed.',
      });
    }
    this._told = state;
    if (state === 'open') {
      this._beforeOpen();
      events.open();
    } else if (state === 'closing') events.closing();
    else if (state === 'closed') events.closed();
  }

  listen(events: RTCDataChannelEvents): void {
    this._events = events;
    this._state(this._ch.readyState);
    const early = this._early.splice(0);
    if (early.length && this._told === 'connecting') this._state('open');
    for (const message of early) events.message(message);
  }
  send(data: string | Uint8Array): void {
    if (data.length === 0) {
      this._sendEmpty(typeof data === 'string');
      return;
    }
    const bytes = typeof data === 'string' ? data : Buffer.from(data);
    this._ch.send(bytes);
    const size =
      typeof data === 'string'
        ? new TextEncoder().encode(data).byteLength
        : data.byteLength;
    queueMicrotask(() => this._events?.sent(size));
  }
  /**
   * An empty message, which werift sends as nothing: it cuts a message into
   * as many chunks as it has bytes' worth, none for none, where RFC 8831
   * (6.6) sends one byte under its own payload protocol — 56 for an empty
   * string, 57 for empty bytes — which werift reads, and turns back into
   * an empty message. So the adapter puts that byte on werift's own send
   * queue, behind what was sent before it, and flushes it as werift's send
   * does. It is the one place the adapter reaches into werift: a werift
   * without the queue sends nothing, as it would have.
   */
  private _sendEmpty(text: boolean): void {
    const sctp = this._sctp();
    const queue = sctp?.dataChannelQueue;
    if (!sctp || typeof queue?.push !== 'function' || !sctp.dataChannelFlush)
      return;
    // werift takes what it flushed off the channel's bufferedAmount
    this._ch.addBufferedAmount(1);
    queue.push([this._ch, text ? 56 : 57, new Uint8Array([0])]);
    // a message all the same, of no bytes, which werift's send would have
    // counted (`RTCDataChannelStats.messagesSent`)
    if (typeof this._ch.messagesSent === 'number') this._ch.messagesSent += 1;
    void sctp.dataChannelFlush();
  }

  /** Whether anything sent on this channel has yet to be handed to SCTP,
   *  which numbers a chunk as it is queued: its `bufferedAmount`, and the
   *  channel's DCEP messages. By the channel, so a neighbour that goes on
   *  sending holds no close up. */
  private _unsent(): boolean {
    if (this._ch.bufferedAmount > 0) return true;
    // the DCEP ACK of a channel the far side opened waits there too, and a
    // close that reset the stream ahead of it left the opener an ACK for a
    // channel it no longer had, which werift throws for where nothing
    // catches it
    for (const [channel] of this._sctp()?.dataChannelQueue ?? []) {
      if (channel === this._ch) return true;
    }
    return false;
  }

  /**
   * Closes it once what was sent has been handed to SCTP. werift resets the
   * stream as it is closed, with what it has not handed over still to go,
   * and that goes out after the reset, on a stream the far side has reset:
   * a channel closed at once lost every message it had not sent yet. What
   * SCTP holds is numbered before the reset's last TSN, and the far side
   * holds the reset until all of it has arrived (RFC 6525, 5.2.2), which
   * werift does from 0.27.0, so a retransmission it overtakes is not lost.
   */
  close(): void {
    if (this._closing) return;
    this._closing = true;
    if (!this._unsent()) {
      this._ch.close();
      return;
    }
    let waiting = true;
    const settled = () => {
      if (!waiting || this._unsent()) return;
      waiting = false;
      // whatever its state: one closed as it opened is still connecting
      this._ch.close();
    };
    this._ch.bufferedAmountLowThreshold = 0;
    this._ch.bufferedAmountLow.subscribe(settled);
    this._sctp()?.sctp?.flush?.subscribe(settled);
  }
}

/** What werift is asked for a data channel the page made. */
function channelOptions(init: RTCDataChannelInitLike): Record<string, unknown> {
  return {
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
  };
}

// --- transports -------------------------------------------------------------

/** A transport's candidate generations, each by its ufrag: the one its
 *  candidates are told in now, the last whose end was told, and every
 *  candidate told, so one told again is not. */
interface Generations {
  now: string | null;
  done: string | null;
  told: Set<string>;
}

/** An association that is up (werift's `SCTP_STATE.ESTABLISHED`). */
const ESTABLISHED = 4;

/**
 * A connection's transports, numbered as each is first seen and watched,
 * and what they and its candidates and the peer's data channels tell.
 */
export class WeriftTransports {
  private readonly _transports = new Map<WDtls, number>();
  private readonly _told = new Map<number, string>();
  /** The ICE state each transport was told in last. */
  private readonly _iceTold = new Map<number, string>();
  /** Each transport's selected pair as told last, and how often it moved. */
  private readonly _pairs = new Map<number, string>();
  private readonly _pairChanges = new Map<number, number>();
  /** Each transport's candidates, by generation (`Generations`). */
  private readonly _generations = new Map<number, Generations>();
  /** What each connected transport last heard on its pair, and since when
   *  it has heard nothing more (`_listen`). */
  private readonly _heard = new Map<
    number,
    { pair: string; count: number; since: number; quiet: boolean }
  >();
  private _listening: unknown = null;
  /** The association being watched, and what was last told of it. */
  private _association: WAssociation | null = null;
  private _sctpTold = 'connecting';

  constructor(
    private readonly _pc: WTransportsPeer,
    private readonly _events: RTCConnectionEvents,
    private readonly _closed: () => boolean,
  ) {
    const pc = _pc;
    pc.onIceCandidate.subscribe((c) => {
      if (this._closed()) return;
      this.watch();
      const transport = c ? this._ofMid(c.sdpMid ?? null) : null;
      // one werift tells again, as an answer commits a restart, the page
      // has had
      if (c && transport !== null && !this._fresh(transport, c)) return;
      // a transport is gathering before its first candidate is told, and
      // complete only after its last
      this.tell();
      if (c && transport !== null) {
        this._events.candidate(transport, candidateOf(c));
      }
    });
    pc.onDataChannel.subscribe((ch) => {
      // werift announces a channel before it opens it and queues its DCEP
      // ACK, and a page's handler runs inside what tells it: one that
      // closed the channel there reset the stream ahead of the ACK, and the
      // opener threw for an ACK of a channel it no longer had, where nothing
      // catches it. So the page hears of it once werift's own steps are done
      const channel = new WeriftChannel(ch, this._sctpUp, this._sctp);
      queueMicrotask(() => this._announce(ch, channel));
    });
    const changed = () => {
      if (this._closed()) return;
      this.watch();
      this.tell();
    };
    pc.iceGatheringStateChange.subscribe(changed);
    pc.iceConnectionStateChange.subscribe(changed);
    pc.connectionStateChange.subscribe(changed);
  }

  /** A channel the far side opened, told to the page. */
  private _announce(ch: WChannel, channel: WeriftChannel): void {
    if (this._closed()) return;
    this._events.dataChannel(channel, {
      label: ch.label,
      ordered: ch.ordered,
      maxPacketLifeTime: ch.maxPacketLifeTime ?? null,
      maxRetransmits: ch.maxRetransmits ?? null,
      protocol: ch.protocol,
      negotiated: ch.negotiated,
      id: typeof ch.id === 'number' ? ch.id : 0,
      priority: 'low',
    });
  }

  /** A data channel the page made. */
  channel(init: RTCDataChannelInitLike): RTCDataChannelLike {
    const ch = this._pc.createDataChannel(init.label, channelOptions(init));
    const channel = new WeriftChannel(ch, this._sctpUp, this._sctp);
    // one made before the association is up has no id until it is
    if (this._association?.associationState !== ESTABLISHED) {
      this._made.add(channel);
    }
    return channel;
  }

  /** Each transport is numbered as it is first seen, and watched, and so
   *  is the association data channels run over. */
  watch(): void {
    for (const dtls of this._pc.dtlsTransports) {
      if (this._transports.has(dtls)) continue;
      this._transports.set(dtls, this._transports.size + 1);
      const changed = () => {
        if (this._closed()) return;
        this._watchAssociation();
        this.tell();
      };
      dtls.onStateChange.subscribe(changed);
      dtls.iceTransport.onStateChange.subscribe(changed);
      const id = this._transports.get(dtls)!;
      // the end of a generation's candidates
      dtls.iceTransport.onIceCandidate?.subscribe((c) => {
        const g = this._generations.get(id);
        if (c !== undefined || !g || g.now === null || this._closed()) return;
        g.done = g.now;
        this.tell();
      });
    }
    this._watchAssociation();
  }

  /**
   * werift makes an association as a transport for data channels is set,
   * and makes another for another transport, so the one in use is looked
   * for each time and watched once found.
   */
  private _held: unknown = null;
  /**
   * WebRTC 1.0's `disconnected`, which werift never tells: a connected
   * transport that has heard nothing on its pair for `QUIET_MS` is
   * disconnected, and connected again as anything comes. werift checks
   * consent every 4 to 6 seconds and has its peer's checks as often, so an
   * idle connection hears something in every 6 seconds, and `QUIET_MS` is
   * past that; it fails only as consent expires, 30 seconds on. Looked at
   * each second while any transport is connected or disconnected.
   */
  private _listen(): void {
    if (this._listening !== null) return;
    const look = () => {
      this._listening = null;
      if (this._closed()) return;
      const now = Date.now();
      let moved = false;
      let any = false;
      for (const [dtls, id] of this._transports) {
        const told = this._iceTold.get(id);
        const pair = dtls.iceTransport.connection?.nominated;
        if (!pair || (!CONNECTED.has(told ?? '') && told !== 'disconnected')) {
          if (this._heard.get(id)?.quiet) moved = true;
          this._heard.delete(id);
          continue;
        }
        any = true;
        const count =
          pair.packetsReceived + pair.requestsReceived + pair.responsesReceived;
        const was = this._heard.get(id);
        if (!was || was.pair !== pair.id || was.count !== count) {
          if (was?.quiet) moved = true;
          this._heard.set(id, {
            pair: pair.id,
            count,
            since: now,
            quiet: false,
          });
        } else if (!was.quiet && now - was.since >= QUIET_MS) {
          was.quiet = true;
          moved = true;
        }
      }
      if (moved) this.tell();
      if (any) this._listen();
    };
    const timer = setTimeout(look, 1000);
    (timer as { unref?(): void }).unref?.();
    this._listening = timer;
  }

  /** Looks again, while a transport is held at `new`, for the candidate
   *  that lets it check. */
  private _holdNew(): void {
    if (this._held !== null) return;
    this._held = setTimeout(() => {
      this._held = null;
      if (!this._closed()) this.tell();
    }, 20);
  }

  /** The channels the page made before the association was up, which are
   *  told their ids as it connects. */
  private readonly _made = new Set<WeriftChannel>();

  private _watchAssociation(): void {
    const association = this._pc.sctpTransport?.sctp;
    if (!association || association === this._association) return;
    this._association = association;
    this._sctpTold = 'connecting';
    association.stateChanged.connected.subscribe(() => {
      // werift gives each channel its id in its own handler, which runs
      // before this one
      if (association === this._association) this._connected();
    });
    association.stateChanged.closed.subscribe(() => {
      if (association === this._association) this._tellSctp('closed');
    });
    if (association.associationState === ESTABLISHED) this._connected();
  }

  /** The association is up: each channel made before it is told the id
   *  werift gave it as it connected, before the transport is told
   *  connected (WebRTC 1.0, 6.1.1.2). Told with the channel's next state
   *  instead, the far side heard of a channel whose opener's id was still
   *  null. */
  private _connected(): void {
    for (const channel of this._made) channel.tellId();
    this._made.clear();
    this._tellSctp('connected');
  }

  /**
   * The association is up, if it is, told before a channel on it opens:
   * werift opens its negotiated channels from its own handler of the
   * association's connecting, which runs before this one's, and WebRTC 1.0
   * tells the SCTP transport connected before it announces a channel open
   * (6.1.1, "update the data max channels").
   */
  private readonly _sctp = (): WSctp | undefined => this._pc.sctpTransport;

  private readonly _sctpUp = (): void => {
    this._watchAssociation();
    if (this._association?.associationState === ESTABLISHED) this._connected();
  };

  private _tellSctp(state: 'connected' | 'closed'): void {
    if (this._closed() || state === this._sctpTold) return;
    this._sctpTold = state;
    const sctp = this._pc.sctpTransport;
    this._events.sctp({
      transport: this.idOf(sctp?.dtlsTransport) ?? 0,
      state,
      maxMessageSize: sctp?.remoteMaxMessageSize ?? 65536,
      maxChannels:
        state === 'connected' ? (this._association?.maxChannels ?? null) : null,
    });
  }

  /** A transport's number, or null for none. */
  idOf(dtls: WDtls | undefined): number | null {
    if (!dtls) return null;
    this.watch();
    return this._transports.get(dtls) ?? null;
  }

  private _ofMid(mid: string | null): number | null {
    const t = this._pc.getTransceivers().find((x) => x.mid === mid);
    const dtls =
      t?.dtlsTransport ??
      this._pc.sctpTransport?.dtlsTransport ??
      this._pc.dtlsTransports[0];
    return this.idOf(dtls);
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
      // werift's own: `iceStateAfter` says what it comes to
      iceState: ice.state as RTCTransportStateLike['iceState'],
      gatheringState:
        ice.gatheringState as RTCTransportStateLike['gatheringState'],
      role: ice.role as RTCTransportStateLike['role'],
      dtlsState: dtls.state as RTCTransportStateLike['dtlsState'],
      remoteCertificates: dtls.dtls?.remoteCertificate
        ? [new Uint8Array(dtls.dtls.remoteCertificate)]
        : [],
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

  /** Whether a candidate is one the page has not had, noting its
   *  generation: by its ufrag, or its transport's where it has none. */
  private _fresh(id: number, c: WCandidate): boolean {
    let g = this._generations.get(id);
    if (!g) {
      g = { now: null, done: null, told: new Set() };
      this._generations.set(id, g);
    }
    let ufrag = c.usernameFragment ?? null;
    if (ufrag === null) {
      for (const [dtls, n] of this._transports) {
        if (n !== id) continue;
        try {
          ufrag = dtls.iceTransport.getLocalParameters().usernameFragment;
        } catch {}
      }
    }
    const key = `${ufrag} ${candidateOf(c).candidate}`;
    if (g.told.has(key)) return false;
    g.told.add(key);
    if (ufrag !== null) g.now = ufrag;
    return true;
  }

  /**
   * A transport's gathering state as a browser tells it, from werift's and
   * the generations its candidates were told in. werift stages an ICE
   * restart's candidates from the sockets it has, and tells them as the
   * description that carries them is set, staying `complete` throughout;
   * a browser gathers for the new credentials, `gathering` until their last
   * candidate. And as the answer commits the restart, werift goes `new`
   * and gathers again, telling the same candidates, where a browser has
   * finished: what the page has had stays `complete`.
   */
  private _gathering(id: number, state: RTCTransportStateLike): void {
    const g = this._generations.get(id);
    if (!g || g.now === null) return;
    if (g.now !== g.done) {
      if (state.gatheringState !== 'complete') return;
      // the first generation ends with werift's own gathering
      if (g.done === null) g.done = g.now;
      else state.gatheringState = 'gathering';
    } else if (
      state.gatheringState !== 'complete' &&
      state.localParameters?.usernameFragment === g.done
    ) {
      state.gatheringState = 'complete';
    }
  }

  /** Tells each transport whose state changed since it was last told. */
  tell(): void {
    for (const [dtls, id] of this._transports) {
      const state = this._snapshot(dtls);
      this._gathering(id, state);
      const was = this._iceTold.get(id) ?? 'new';
      state.iceState = iceStateAfter(was, state.iceState, !!state.selectedPair);
      // it checks nothing before it has one of the peer's candidates, where
      // werift's agent checks as an answer is applied (WebRTC 1.0,
      // RTCIceTransportState)
      if (
        was === 'new' &&
        state.iceState === 'checking' &&
        !heardOfPeer(dtls.iceTransport)
      ) {
        state.iceState = 'new';
        // a peer-reflexive candidate comes with a check, which changes none
        // of werift's states, so a transport held is looked at again
        this._holdNew();
      }
      // a transport is checking before it is first connected
      if (was === 'new' && CONNECTED.has(state.iceState)) {
        this._send(id, { ...state, iceState: 'checking' });
      }
      // what has heard nothing for a while is disconnected (`_listen`)
      if (CONNECTED.has(state.iceState) && this._heard.get(id)?.quiet) {
        state.iceState = 'disconnected';
      }
      this._send(id, state);
      if (CONNECTED.has(state.iceState)) this._listen();
    }
  }

  private _send(id: number, state: RTCTransportStateLike): void {
    const key = JSON.stringify(state);
    if (this._told.get(id) === key) return;
    this._told.set(id, key);
    this._iceTold.set(id, state.iceState);
    const pair = state.selectedPair ? JSON.stringify(state.selectedPair) : null;
    if (pair && pair !== this._pairs.get(id)) {
      this._pairs.set(id, pair);
      this._pairChanges.set(id, (this._pairChanges.get(id) ?? 0) + 1);
    }
    this._events.transport(id, state);
  }

  /**
   * The connection's stats, each object as plain data, its transports' as
   * the page would read them: werift says `completed` for a transport that
   * has only gathered, leaves out the roles until it is connected, and
   * names the DTLS version and the SRTP profile otherwise than the stats
   * do.
   */
  async stats(): Promise<RTCStatsLike[]> {
    this.watch();
    const report = await this._pc.getStats();
    const out: RTCStatsLike[] = [];
    const signalled = this._signalled();
    for (const s of report.values()) {
      const stat = JSON.parse(JSON.stringify(s)) as RTCStatsLike;
      if (stat.type === 'transport') this._transportStats(stat);
      else if (stat.type === 'remote-candidate') hideLearned(stat, signalled);
      else if (stat.type === 'certificate') derCertificate(stat);
      out.push(stat);
    }
    return out;
  }

  /** The peer's candidates it signalled, on any transport, as
   *  `address port`: what a peer-reflexive candidate is known by. */
  private _signalled(): Set<string> {
    const out = new Set<string>();
    for (const dtls of this._transports.keys()) {
      for (const c of dtls.iceTransport.connection?.remoteCandidates ?? []) {
        const { type, host, port } = c as {
          type?: string;
          host?: string;
          port?: number;
        };
        if (type !== 'prflx') out.add(`${host} ${port}`);
      }
    }
    return out;
  }

  private _transportStats(stat: RTCStatsLike): void {
    for (const [dtls, id] of this._transports) {
      if (stat.id !== `transport_${dtls.id}`) continue;
      stat.iceState = this._iceTold.get(id) ?? 'new';
      stat.selectedCandidatePairChanges = this._pairChanges.get(id) ?? 0;
    }
    if (stat.iceRole === undefined) {
      // the offerer controls (RFC 8445, 6.1.1), whatever werift has worked
      // out yet
      const pc = this._pc;
      stat.iceRole =
        pc.pendingLocalDescription?.type === 'offer'
          ? 'controlling'
          : pc.pendingRemoteDescription?.type === 'offer'
            ? 'controlled'
            : 'unknown';
    }
    if (stat.dtlsRole === undefined) stat.dtlsRole = 'unknown';
    const version = TLS_VERSIONS[String(stat.tlsVersion)];
    if (version) stat.tlsVersion = version;
    const cipher = SRTP_CIPHERS[String(stat.srtpCipher)];
    if (cipher) stat.srtpCipher = cipher;
  }
}

const CONNECTED = new Set(['connected', 'completed']);
/** How long a connected transport hears nothing before it is
 *  disconnected: past werift's consent cadence (`_listen`). */
const QUIET_MS = 7000;

/**
 * A remote candidate's stats as a page may read them. One the agent learned
 * from a check (peer-reflexive), whose address no signalling told the page,
 * has its address, its related address and its ufrag left out, as WebRTC
 * 1.0 and webrtc-stats keep them (RTCIceCandidateStats, "address"); werift
 * reports every one.
 */
function hideLearned(stat: RTCStatsLike, signalled: Set<string>): void {
  if (stat.candidateType !== 'prflx') return;
  if (signalled.has(`${stat.address} ${stat.port}`)) return;
  stat.address = null;
  stat.relatedAddress = null;
  delete stat.usernameFragment;
}

/**
 * A certificate's stats with `base64Certificate` the DER, as webrtc-stats
 * has it: werift writes the base64 of the local certificate's PEM text,
 * which hashes to nothing its fingerprint names. The DER is the PEM's own
 * base64 between its armour lines.
 */
function derCertificate(stat: RTCStatsLike): void {
  const value = stat.base64Certificate;
  if (typeof value !== 'string') return;
  let text: string;
  try {
    text = atob(value);
  } catch {
    return;
  }
  const pem =
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(text);
  if (pem) stat.base64Certificate = pem[1].replace(/\s+/g, '');
}

/** Whether a transport has one of the peer's candidates, signalled or found
 *  as peer-reflexive (WebRTC 1.0, RTCIceTransportState `checking`). One
 *  that cannot say is taken to have. */
function heardOfPeer(ice: WIce): boolean {
  const all = ice.connection?.remoteCandidates;
  if (Array.isArray(all)) return all.length > 0;
  const signalled = ice.getRemoteCandidates?.();
  return !signalled || signalled.length > 0;
}

/**
 * The ICE state a transport is told in, from the one it was told in last and
 * werift's now. werift's agent says `completed` once it has gathered its
 * candidates, before it has checked anything, then `checking` and
 * `connected`; its controlled side is `completed` again as soon as a pair is
 * nominated, where WebRTC 1.0's `completed` waits for the remote's end of
 * candidates too, which werift never tells; and an ICE restart takes it back
 * to `new` and `checking`. WebRTC 1.0 has `new`, `checking`, `connected`,
 * and a restart of a connected transport stays connected. So `completed` is
 * `connected` where a pair is selected and nothing otherwise, a transport
 * once connected goes back to neither `new` nor `checking`, and it is
 * connected only with a pair, which a page reads as it hears so.
 */
function iceStateAfter(
  was: string,
  raw: RTCTransportStateLike['iceState'],
  paired: boolean,
): RTCTransportStateLike['iceState'] {
  const told = was as RTCTransportStateLike['iceState'];
  const now = raw === 'completed' ? (paired ? 'connected' : told) : raw;
  if (CONNECTED.has(was) && (now === 'new' || now === 'checking')) return told;
  if (CONNECTED.has(now) && !paired && !CONNECTED.has(was)) return 'checking';
  return now;
}

/** A DTLS version as the stats name it: the hex of the version field. */
const TLS_VERSIONS: Record<string, string> = {
  'DTLS 1.0': 'FEFF',
  'DTLS 1.2': 'FEFD',
  'DTLS 1.3': 'FEFC',
};

/** An SRTP protection profile as the stats name it: IANA's name. */
const SRTP_CIPHERS: Record<string, string> = {
  AES_CM_128_HMAC_SHA1_80: 'SRTP_AES128_CM_HMAC_SHA1_80',
  AES_CM_128_HMAC_SHA1_32: 'SRTP_AES128_CM_HMAC_SHA1_32',
  AEAD_AES_128_GCM: 'SRTP_AEAD_AES_128_GCM',
  AEAD_AES_256_GCM: 'SRTP_AEAD_AES_256_GCM',
};
