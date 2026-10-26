// WebRTC 1.0's candidates and transports, as a page's scripts see them:
// `RTCIceCandidate` and the events that carry one, `RTCIceTransport`,
// `RTCDtlsTransport` and the pair a transport selected, and
// `RTCStatsReport`. Also the states a connection works out from its
// transports' (WebRTC 1.0, 4.3.2 and 4.3.3), and the entries the host tells
// these through (`peers.ts`): a transport's state, a candidate, a STUN or
// TURN server's error, the SCTP transport and a remote data channel.
//
// **This function is source text**, as `installWebRTC` is (`webrtc.ts`): it
// closes over nothing, and `installWebRTC` calls it with its own helpers
// and what these read of a connection. So the two share one set of slots: a
// sender's `transport` is one of these objects, and `addIceCandidate` puts
// its candidate on one.

/** What `installWebRTC` hands this: its helpers, and what of a connection
 *  the transports read. */
export interface RtcTransportsDeps {
  slots: WeakMap<object, unknown>;
  slotOf(self: unknown, tag: string): unknown;
  apply: unknown;
  wmGet: unknown;
  wmSet: unknown;
  /** What the constructors a page may not call check for. */
  TOKEN: object;
  illegalConstructor(): unknown;
  handler(proto: unknown, name: string): void;
  typeError(message: string): unknown;
  enforce(value: unknown, max: number, what: string): number;
  dictionary(value: unknown, what: string): unknown;
  simple(target: unknown, type: string): void;
  fire(target: unknown, event: unknown): void;
  Event: unknown;
  EventTarget: unknown;
  setTimer(fn: () => void, ms: number): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  bytesOfBase64(text: string): Uint8Array;
  stringify(value: unknown): string;
  rejected(error: unknown): Promise<unknown>;
  then(p: unknown, ok: unknown, bad?: unknown): unknown;
  invalidState(message?: string): unknown;
  /** A request of the host's, settled by `__rtcSettled`. */
  ask(run: (req: number) => void): Promise<unknown>;
  /** `datachannel.ts`'s internals. */
  channels: unknown;
  /** A connection's slot, by the number the host knows it by. */
  connectionOf(id: number): unknown;
  /** The mid and m-line index of the first section a transport carries. */
  sectionOfTransport(s: unknown, id: number): [string | null, number | null];
  /** The transports a connection uses now. */
  transportsInUse(s: unknown): number[];
}

export function installRtcTransports(
  deps: RtcTransportsDeps,
): Record<string, unknown> {
  'use strict';
  type Any = any;
  const H: Any = deps;
  const slots: Any = H.slots;
  const slotOf: Any = H.slotOf;
  const apply: Any = H.apply;
  const wmGet: Any = H.wmGet;
  const wmSet: Any = H.wmSet;
  const TOKEN: Any = H.TOKEN;
  const illegalConstructor: Any = H.illegalConstructor;
  const handler: Any = H.handler;
  const typeError: Any = H.typeError;
  const enforce: Any = H.enforce;
  const dictionary: Any = H.dictionary;
  const simple: Any = H.simple;
  const fire: Any = H.fire;
  const Event: Any = H.Event;
  const EventTarget: Any = H.EventTarget;
  const setTimer: Any = H.setTimer;
  const entry: Any = H.entry;
  const input: Any = H.input;
  const call: Any = H.call;
  const bytesOfBase64: Any = H.bytesOfBase64;
  const stringify: Any = H.stringify;
  const rejected: Any = H.rejected;
  const then: Any = H.then;
  const invalidState: Any = H.invalidState;
  const ask: Any = H.ask;
  const channels: Any = H.channels;
  const connections = { get: (id: number): Any => H.connectionOf(id) };
  const sectionOfTransport: Any = H.sectionOfTransport;
  const transportsInUse: Any = H.transportsInUse;

  // --- candidates ---------------------------------------------------------------

  /** A candidate attribute's fields (RFC 8839, 5.1), or null where it is
   *  not one. */
  const parseCandidate = (text: string): Any => {
    let line = text.trim();
    if (line.startsWith('a=')) line = line.slice(2);
    if (!line.startsWith('candidate:')) return null;
    const t = line.slice('candidate:'.length).split(/\s+/);
    if (t.length < 8 || t[6] !== 'typ') return null;
    const port = Number(t[5]);
    const priority = Number(t[3]);
    if (!Number.isInteger(port) || !Number.isFinite(priority)) return null;
    const out: Any = {
      foundation: t[0],
      component: t[1] === '1' ? 'rtp' : t[1] === '2' ? 'rtcp' : null,
      protocol:
        t[2].toLowerCase() === 'tcp'
          ? 'tcp'
          : t[2].toLowerCase() === 'udp'
            ? 'udp'
            : null,
      priority,
      address: t[4],
      port,
      type: ['host', 'srflx', 'prflx', 'relay'].includes(t[7]) ? t[7] : null,
      tcpType: null,
      relatedAddress: null,
      relatedPort: null,
      ufrag: null,
    };
    for (let i = 8; i + 1 < t.length; i += 2) {
      const key = t[i];
      const value = t[i + 1];
      if (key === 'raddr') out.relatedAddress = value;
      else if (key === 'rport') out.relatedPort = Number(value);
      else if (key === 'tcptype') {
        out.tcpType = ['active', 'passive', 'so'].includes(value)
          ? value
          : null;
      } else if (key === 'ufrag') out.ufrag = value;
    }
    return out;
  };

  /** An `RTCIceCandidateInit` as Web IDL converts it: each member read
   *  once, in their order. */
  const iceInitOf = (value: Any): Any => {
    const i = dictionary(value, 'RTCIceCandidateInit');
    const candidate = i.candidate;
    const sdpMLineIndex = i.sdpMLineIndex;
    const sdpMid = i.sdpMid;
    const usernameFragment = i.usernameFragment;
    return {
      candidate:
        candidate === undefined || candidate === null ? '' : String(candidate),
      sdpMLineIndex:
        sdpMLineIndex === undefined || sdpMLineIndex === null
          ? null
          : enforce(sdpMLineIndex, 65535, 'sdpMLineIndex'),
      sdpMid: sdpMid === undefined || sdpMid === null ? null : String(sdpMid),
      usernameFragment:
        usernameFragment === undefined || usernameFragment === null
          ? null
          : String(usernameFragment),
    };
  };

  class RTCIceCandidate {
    constructor(init: Any = {}) {
      const i = iceInitOf(init);
      const candidate: string = i.candidate;
      const sdpMid: string | null = i.sdpMid;
      const sdpMLineIndex: number | null = i.sdpMLineIndex;
      if (sdpMid === null && sdpMLineIndex === null) {
        throw typeError(
          "Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null.",
        );
      }
      const fields = parseCandidate(candidate);
      const usernameFragment = i.usernameFragment ?? fields?.ufrag ?? null;
      apply(wmSet, slots, [
        this,
        {
          iceCandidate: true,
          candidate,
          sdpMid,
          sdpMLineIndex,
          usernameFragment,
          fields,
          relayProtocol: null,
          url: null,
        },
      ]);
    }
    get candidate(): string {
      return slotOf(this, 'iceCandidate').candidate;
    }
    get sdpMid(): Any {
      return slotOf(this, 'iceCandidate').sdpMid;
    }
    get sdpMLineIndex(): Any {
      return slotOf(this, 'iceCandidate').sdpMLineIndex;
    }
    get usernameFragment(): Any {
      return slotOf(this, 'iceCandidate').usernameFragment;
    }
    get foundation(): Any {
      return slotOf(this, 'iceCandidate').fields?.foundation ?? null;
    }
    get component(): Any {
      return slotOf(this, 'iceCandidate').fields?.component ?? null;
    }
    get priority(): Any {
      return slotOf(this, 'iceCandidate').fields?.priority ?? null;
    }
    get address(): Any {
      return slotOf(this, 'iceCandidate').fields?.address ?? null;
    }
    get protocol(): Any {
      return slotOf(this, 'iceCandidate').fields?.protocol ?? null;
    }
    get port(): Any {
      return slotOf(this, 'iceCandidate').fields?.port ?? null;
    }
    get type(): Any {
      return slotOf(this, 'iceCandidate').fields?.type ?? null;
    }
    get tcpType(): Any {
      return slotOf(this, 'iceCandidate').fields?.tcpType ?? null;
    }
    get relatedAddress(): Any {
      return slotOf(this, 'iceCandidate').fields?.relatedAddress ?? null;
    }
    get relatedPort(): Any {
      return slotOf(this, 'iceCandidate').fields?.relatedPort ?? null;
    }
    get relayProtocol(): Any {
      return slotOf(this, 'iceCandidate').relayProtocol;
    }
    get url(): Any {
      return slotOf(this, 'iceCandidate').url;
    }
    toJSON(): Any {
      const s = slotOf(this, 'iceCandidate');
      return {
        candidate: s.candidate,
        sdpMid: s.sdpMid,
        sdpMLineIndex: s.sdpMLineIndex,
        usernameFragment: s.usernameFragment,
      };
    }
  }

  class RTCPeerConnectionIceEvent extends Event {
    constructor(type: string, init: Any = {}) {
      const i = dictionary(init, 'RTCPeerConnectionIceEventInit');
      super(type, i);
      apply(wmSet, slots, [
        this,
        {
          iceEvent: true,
          candidate: i.candidate ?? null,
          url: i.url === undefined || i.url === null ? null : String(i.url),
        },
      ]);
    }
    get candidate(): Any {
      return slotOf(this, 'iceEvent').candidate;
    }
    get url(): Any {
      return slotOf(this, 'iceEvent').url;
    }
  }

  class RTCPeerConnectionIceErrorEvent extends Event {
    constructor(type: string, init: Any) {
      if (!init || init.errorCode === undefined) {
        throw typeError(
          "Failed to construct 'RTCPeerConnectionIceErrorEvent': required member errorCode is undefined.",
        );
      }
      super(type, init);
      apply(wmSet, slots, [
        this,
        {
          iceErrorEvent: true,
          address: init.address ?? null,
          port: init.port ?? null,
          url: init.url === undefined ? '' : String(init.url),
          errorCode: enforce(init.errorCode, 65535, 'errorCode'),
          errorText: init.errorText === undefined ? '' : String(init.errorText),
        },
      ]);
    }
    get address(): Any {
      return slotOf(this, 'iceErrorEvent').address;
    }
    get port(): Any {
      return slotOf(this, 'iceErrorEvent').port;
    }
    get url(): string {
      return slotOf(this, 'iceErrorEvent').url;
    }
    get errorCode(): number {
      return slotOf(this, 'iceErrorEvent').errorCode;
    }
    get errorText(): string {
      return slotOf(this, 'iceErrorEvent').errorText;
    }
  }

  // --- transports ---------------------------------------------------------------

  interface TransportState {
    iceState: string;
    gatheringState: string;
    role: string;
    dtlsState: string;
    remoteCertificates: string[];
    selectedPair: Any;
    localParameters: Any;
    remoteParameters: Any;
  }

  class RTCIceCandidatePair {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
    }
    get local(): Any {
      return slotOf(this, 'candidatePair').local;
    }
    get remote(): Any {
      return slotOf(this, 'candidatePair').remote;
    }
  }

  class RTCIceTransport extends EventTarget {
    constructor(token: Any = undefined) {
      super();
      if (token !== TOKEN) throw illegalConstructor();
    }
    get role(): string {
      return slotOf(this, 'iceTransport').state.role;
    }
    get component(): string {
      slotOf(this, 'iceTransport');
      return 'rtp';
    }
    get state(): string {
      return slotOf(this, 'iceTransport').state.iceState;
    }
    get gatheringState(): string {
      return slotOf(this, 'iceTransport').state.gatheringState;
    }
    getLocalCandidates(): Any[] {
      return slotOf(this, 'iceTransport').local.slice();
    }
    getRemoteCandidates(): Any[] {
      return slotOf(this, 'iceTransport').remote.slice();
    }
    getSelectedCandidatePair(): Any {
      const pair = slotOf(this, 'iceTransport').state.selectedPair;
      if (!pair) return null;
      const out = new RTCIceCandidatePair(TOKEN);
      apply(wmSet, slots, [
        out,
        {
          candidatePair: true,
          local: candidateFrom(pair.local),
          remote: candidateFrom(pair.remote),
        },
      ]);
      return out;
    }
    getLocalParameters(): Any {
      const p = slotOf(this, 'iceTransport').state.localParameters;
      return p
        ? { usernameFragment: p.usernameFragment, password: p.password }
        : null;
    }
    getRemoteParameters(): Any {
      const p = slotOf(this, 'iceTransport').state.remoteParameters;
      return p
        ? { usernameFragment: p.usernameFragment, password: p.password }
        : null;
    }
  }
  for (const name of [
    'statechange',
    'gatheringstatechange',
    'selectedcandidatepairchange',
  ]) {
    handler(RTCIceTransport.prototype, name);
  }

  class RTCDtlsTransport extends EventTarget {
    constructor(token: Any = undefined) {
      super();
      if (token !== TOKEN) throw illegalConstructor();
    }
    get iceTransport(): Any {
      return slotOf(this, 'dtlsTransport').ice;
    }
    get state(): string {
      return slotOf(this, 'dtlsTransport').state.dtlsState;
    }
    getRemoteCertificates(): Any[] {
      return slotOf(this, 'dtlsTransport').state.remoteCertificates.map(
        (b64: string) => bytesOfBase64(b64).slice().buffer,
      );
    }
  }
  for (const name of ['statechange', 'error']) {
    handler(RTCDtlsTransport.prototype, name);
  }

  const NEW_TRANSPORT: TransportState = {
    iceState: 'new',
    gatheringState: 'new',
    role: 'unknown',
    dtlsState: 'new',
    remoteCertificates: [],
    selectedPair: null,
    localParameters: null,
    remoteParameters: null,
  };

  /** A connection's transport by the host's number, made as it is first
   *  named. */
  const transportOf = (s: Any, id: number): Any => {
    let t = s.transports.get(id);
    if (t) return t;
    const ice = new RTCIceTransport(TOKEN);
    const dtls = new RTCDtlsTransport(TOKEN);
    t = { id, ice, dtls, state: { ...NEW_TRANSPORT } };
    apply(wmSet, slots, [
      ice,
      { iceTransport: true, state: t.state, local: [], remote: [] },
    ]);
    apply(wmSet, slots, [dtls, { dtlsTransport: true, ice, state: t.state }]);
    s.transports.set(id, t);
    return t;
  };
  const setTransportState = (t: Any, state: TransportState): void => {
    t.state = state;
    apply(wmGet, slots, [t.ice]).state = state;
    apply(wmGet, slots, [t.dtls]).state = state;
  };

  /** A candidate attribute's fields up to its type, which say which
   *  candidate it is whatever follows them. */
  const candidateKey = (text: string): string =>
    text.trim().split(/\s+/).slice(0, 8).join(' ');

  /**
   * A local description as the page has it. A stack may gather candidates
   * as a description is set — werift gathers its host candidates inside
   * `setLocalDescription` — but a candidate is added to the description as
   * it is surfaced, with its `icecandidate` (WebRTC 1.0, 4.4.1.6,
   * "surface the candidate"), and a page that hands its description on
   * before it has heard of them hands on none. So it holds the candidates
   * the page has heard of, and their end once the page has heard that.
   */
  const surfacedOnly = (s: Any, sdp: string | null): string | null => {
    if (typeof sdp !== 'string') return sdp;
    if (
      sdp.indexOf('a=candidate:') < 0 &&
      sdp.indexOf('a=end-of-candidates') < 0
    ) {
      return sdp;
    }
    const heard = new Set<string>();
    for (const t of s.transports.values()) {
      for (const c of apply(wmGet, slots, [t.ice]).local) {
        heard.add(candidateKey(slotOf(c, 'iceCandidate').candidate));
      }
    }
    return sdp
      .replace(
        /^a=candidate:([^\r\n]*)(\r?\n)?/gm,
        (whole: string, rest: string) =>
          heard.has(candidateKey('candidate:' + rest)) ? whole : '',
      )
      .replace(/^a=end-of-candidates(\r?\n)?/gm, (whole: string) =>
        s.gathering === 'complete' ? whole : '',
      );
  };

  const candidateFrom = (c: Any): Any =>
    new RTCIceCandidate({
      candidate: c.candidate,
      sdpMid: c.sdpMid ?? '0',
      sdpMLineIndex: c.sdpMLineIndex,
      usernameFragment: c.usernameFragment,
    });

  // --- stats ----------------------------------------------------------------------

  class RTCStatsReport {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegalConstructor();
    }
    get size(): number {
      return slotOf(this, 'report').map.size;
    }
    get(key: Any): Any {
      return slotOf(this, 'report').map.get(String(key));
    }
    has(key: Any): boolean {
      return slotOf(this, 'report').map.has(String(key));
    }
    keys(): Any {
      return slotOf(this, 'report').map.keys();
    }
    values(): Any {
      return slotOf(this, 'report').map.values();
    }
    entries(): Any {
      return slotOf(this, 'report').map.entries();
    }
    forEach(fn: Any, thisArg?: Any): void {
      for (const [k, v] of slotOf(this, 'report').map)
        fn.call(thisArg, v, k, this);
    }
    [Symbol.iterator](): Any {
      return slotOf(this, 'report').map.entries();
    }
  }
  const reportOf = (list: Any[]): Any => {
    const report = new RTCStatsReport(TOKEN);
    const map = new Map();
    for (const s of list ?? [])
      if (s && s.id !== undefined) map.set(String(s.id), s);
    apply(wmSet, slots, [report, { report: true, map }]);
    return report;
  };
  const statsOf = (pc: Any, tx: Any, side: string): Promise<Any> => {
    if (pc.closed) return rejected(invalidState());
    return then(
      ask((req: number) =>
        call('rtcStats', pc.id, req, side, tx ? tx.id : null),
      ),
      (list: Any) => reportOf(list),
    );
  };

  // --- what a connection works out from its transports ----------------------

  /** The aggregate states, worked out again from the transports in use, and
   *  told where they moved (WebRTC 1.0, 4.3.2 and 4.3.3). */
  const updateStates = (s: Any): void => {
    if (s.closed) return;
    const states: TransportState[] = transportsInUse(s).map(
      (id: number) => transportOf(s, id).state,
    );
    const ice = states.map((t) => t.iceState);
    const dtls = states.map((t) => t.dtlsState);
    const gathering = states.map((t) => t.gatheringState);
    const any = (list: string[], ...v: string[]) =>
      list.some((x) => v.includes(x));
    const all = (list: string[], ...v: string[]) =>
      list.every((x) => v.includes(x));
    const iceState = any(ice, 'failed')
      ? 'failed'
      : any(ice, 'disconnected')
        ? 'disconnected'
        : all(ice, 'new', 'closed')
          ? 'new'
          : any(ice, 'new', 'checking')
            ? 'checking'
            : all(ice, 'completed', 'closed')
              ? 'completed'
              : 'connected';
    const connState =
      any(ice, 'failed') || any(dtls, 'failed')
        ? 'failed'
        : any(ice, 'disconnected')
          ? 'disconnected'
          : all(ice, 'new', 'closed') && all(dtls, 'new', 'closed')
            ? 'new'
            : any(ice, 'new', 'checking') || any(dtls, 'new', 'connecting')
              ? 'connecting'
              : 'connected';
    const gatherState = any(gathering, 'gathering')
      ? 'gathering'
      : gathering.length && all(gathering, 'complete')
        ? 'complete'
        : 'new';
    if (gatherState !== s.gathering) {
      s.gathering = gatherState;
      simple(s.self, 'icegatheringstatechange');
      if (gatherState === 'complete') {
        fire(
          s.self,
          new RTCPeerConnectionIceEvent('icecandidate', { candidate: null }),
        );
      }
    }
    if (iceState !== s.iceState) {
      s.iceState = iceState;
      simple(s.self, 'iceconnectionstatechange');
    }
    if (connState !== s.connState) {
      s.connState = connState;
      simple(s.self, 'connectionstatechange');
    }
  };

  // --- what the host tells ---------------------------------------------------

  // a transport moved: its objects' events, then the connection's
  entry('__rtcTransport', () => {
    const [pcId, id, state] = input() as [number, number, TransportState];
    const s = connections.get(pcId);
    if (!s || s.closed) return null;
    const t = transportOf(s, id);
    const before: TransportState = t.state;
    if (
      before.gatheringState !== 'complete' &&
      state.gatheringState === 'complete'
    ) {
      // the end of a transport's candidates, then, in a task of its own,
      // what its gathering coming to an end changes (webrtc-pc#2894)
      const [mid, index] = sectionOfTransport(s, id);
      fire(
        s.self,
        new RTCPeerConnectionIceEvent('icecandidate', {
          candidate: new RTCIceCandidate({
            candidate: '',
            sdpMid: mid ?? '0',
            sdpMLineIndex: index,
            usernameFragment: state.localParameters?.usernameFragment ?? null,
          }),
        }),
      );
      setTimer(() => {
        if (s.closed) return;
        transportMoved(s, t, before, state);
      }, 0);
      return null;
    }
    transportMoved(s, t, before, state);
    return null;
  });

  const transportMoved = (
    s: Any,
    t: Any,
    before: TransportState,
    state: TransportState,
  ): void => {
    setTransportState(t, state);
    if (before.gatheringState !== state.gatheringState)
      simple(t.ice, 'gatheringstatechange');
    if (before.iceState !== state.iceState) simple(t.ice, 'statechange');
    if (
      stringify(before.selectedPair) !== stringify(state.selectedPair) &&
      state.selectedPair
    ) {
      simple(t.ice, 'selectedcandidatepairchange');
    }
    if (before.dtlsState !== state.dtlsState) simple(t.dtls, 'statechange');
    updateStates(s);
  };

  // a candidate was gathered: its transport has it, then the page hears it
  entry('__rtcCandidate', () => {
    const [pcId, id, c] = input() as [number, number, Any];
    const s = connections.get(pcId);
    if (!s || s.closed) return null;
    const candidate = new RTCIceCandidate({
      candidate: c.candidate,
      sdpMid: c.sdpMid ?? '0',
      sdpMLineIndex: c.sdpMLineIndex,
      usernameFragment: c.usernameFragment,
    });
    const t = transportOf(s, id);
    apply(wmGet, slots, [t.ice]).local.push(candidate);
    fire(s.self, new RTCPeerConnectionIceEvent('icecandidate', { candidate }));
    return null;
  });

  entry('__rtcCandidateError', () => {
    const [pcId, e] = input() as [number, Any];
    const s = connections.get(pcId);
    if (!s || s.closed) return null;
    fire(
      s.self,
      new RTCPeerConnectionIceErrorEvent('icecandidateerror', {
        address: e.address,
        port: e.port,
        url: e.url,
        errorCode: e.errorCode,
        errorText: e.errorText,
      }),
    );
    return null;
  });

  entry('__rtcSctp', () => {
    const [pcId, state] = input() as [number, Any];
    const s = connections.get(pcId);
    if (!s || s.closed) return null;
    channels.sctpState(s, state);
    return null;
  });

  entry('__rtcDataChannel', () => {
    const [pcId, ch, init] = input() as [number, number, Any];
    const s = connections.get(pcId);
    if (!s || s.closed) return null;
    channels.remote(s, ch, init);
    return null;
  });

  return {
    parseCandidate,
    iceInitOf,
    RTCIceCandidate,
    RTCPeerConnectionIceEvent,
    RTCPeerConnectionIceErrorEvent,
    RTCIceCandidatePair,
    RTCIceTransport,
    RTCDtlsTransport,
    transportOf,
    setTransportState,
    RTCStatsReport,
    statsOf,
    updateStates,
    surfacedOnly,
  };
}
