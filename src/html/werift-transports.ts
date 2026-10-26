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
  readonly state: string;
  readonly iceTransport: WIce;
  readonly onStateChange: WEvent<[string]>;
}

export interface WSctp {
  readonly dtlsTransport?: WDtls;
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

/** A data channel the page made on a connection. */
export function weriftChannel(
  pc: WTransportsPeer,
  init: RTCDataChannelInitLike,
): RTCDataChannelLike {
  const ch = pc.createDataChannel(init.label, {
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

/** A connection's stats, each object as plain data. */
export async function weriftStats(
  pc: WTransportsPeer,
): Promise<RTCStatsLike[]> {
  const report = await pc.getStats();
  const out: RTCStatsLike[] = [];
  for (const s of report.values()) {
    out.push(JSON.parse(JSON.stringify(s)) as RTCStatsLike);
  }
  return out;
}

// --- transports -------------------------------------------------------------

/**
 * A connection's transports, numbered as each is first seen and watched,
 * and what they and its candidates and the peer's data channels tell.
 */
export class WeriftTransports {
  private readonly _transports = new Map<WDtls, number>();
  private readonly _told = new Map<number, string>();

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
      if (this._closed()) return;
      this.watch();
      this.tell();
    };
    pc.iceGatheringStateChange.subscribe(changed);
    pc.iceConnectionStateChange.subscribe(changed);
    pc.connectionStateChange.subscribe(changed);
  }

  /** Each transport is numbered as it is first seen, and watched. */
  watch(): void {
    for (const dtls of this._pc.dtlsTransports) {
      if (this._transports.has(dtls)) continue;
      this._transports.set(dtls, this._transports.size + 1);
      const changed = () => {
        if (!this._closed()) this.tell();
      };
      dtls.onStateChange.subscribe(changed);
      dtls.iceTransport.onStateChange.subscribe(changed);
    }
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
  tell(): void {
    for (const [dtls, id] of this._transports) {
      const state = this._snapshot(dtls);
      const key = JSON.stringify(state);
      if (this._told.get(id) === key) continue;
      this._told.set(id, key);
      this._events.transport(id, state);
    }
  }
}
