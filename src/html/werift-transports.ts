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

declare const queueMicrotask: (fn: () => void) => void;
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
}

export interface WSctp {
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

  constructor(
    private readonly _ch: WChannel,
    /** What is told before it is told open: its association's state. */
    private readonly _beforeOpen: () => void,
  ) {
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
  /**
   * Closes it once what was sent has gone. werift resets the stream as it
   * is closed, with what it has queued still unsent, and its far side
   * drops whatever arrives after a reset — it does none of RFC 6525's
   * deferred reset processing (5.2.2) — so a channel closed at once lost
   * every message it had not sent yet.
   */
  close(): void {
    if (this._closing) return;
    this._closing = true;
    if (!(this._ch.bufferedAmount > 0)) {
      this._ch.close();
      return;
    }
    this._ch.bufferedAmountLowThreshold = 0;
    this._ch.bufferedAmountLow.subscribe(() => {
      if (this._ch.readyState === 'open') this._ch.close();
    });
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
      // a transport is gathering before its first candidate is told, and
      // complete only after its last
      this.tell();
      if (!c) return;
      const transport = this._ofMid(c.sdpMid ?? null);
      if (transport !== null) this._events.candidate(transport, candidateOf(c));
    });
    pc.onDataChannel.subscribe((ch) => {
      if (this._closed()) return;
      this._events.dataChannel(new WeriftChannel(ch, this._sctpUp), {
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
      if (this._closed()) return;
      this.watch();
      this.tell();
    };
    pc.iceGatheringStateChange.subscribe(changed);
    pc.iceConnectionStateChange.subscribe(changed);
    pc.connectionStateChange.subscribe(changed);
  }

  /** A data channel the page made. */
  channel(init: RTCDataChannelInitLike): RTCDataChannelLike {
    const ch = this._pc.createDataChannel(init.label, channelOptions(init));
    return new WeriftChannel(ch, this._sctpUp);
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
    }
    this._watchAssociation();
  }

  /**
   * werift makes an association as a transport for data channels is set,
   * and makes another for another transport, so the one in use is looked
   * for each time and watched once found.
   */
  private _watchAssociation(): void {
    const association = this._pc.sctpTransport?.sctp;
    if (!association || association === this._association) return;
    this._association = association;
    this._sctpTold = 'connecting';
    association.stateChanged.connected.subscribe(() => {
      if (association === this._association) this._tellSctp('connected');
    });
    association.stateChanged.closed.subscribe(() => {
      if (association === this._association) this._tellSctp('closed');
    });
    if (association.associationState === ESTABLISHED) {
      this._tellSctp('connected');
    }
  }

  /**
   * The association is up, if it is, told before a channel on it opens:
   * werift opens its negotiated channels from its own handler of the
   * association's connecting, which runs before this one's, and WebRTC 1.0
   * tells the SCTP transport connected before it announces a channel open
   * (6.1.1, "update the data max channels").
   */
  private readonly _sctpUp = (): void => {
    this._watchAssociation();
    if (this._association?.associationState === ESTABLISHED) {
      this._tellSctp('connected');
    }
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

  /** Tells each transport whose state changed since it was last told. */
  tell(): void {
    for (const [dtls, id] of this._transports) {
      const state = this._snapshot(dtls);
      const was = this._iceTold.get(id) ?? 'new';
      state.iceState = iceStateAfter(was, state.iceState, !!state.selectedPair);
      // a transport is checking before it is first connected
      if (was === 'new' && CONNECTED.has(state.iceState)) {
        this._send(id, { ...state, iceState: 'checking' });
      }
      this._send(id, state);
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
    for (const s of report.values()) {
      const stat = JSON.parse(JSON.stringify(s)) as RTCStatsLike;
      if (stat.type === 'transport') this._transportStats(stat);
      out.push(stat);
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
