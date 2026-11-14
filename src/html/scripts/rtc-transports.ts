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
  /** The text of a connection's current and pending remote descriptions,
   *  whose candidates the page signalled. */
  remoteText(s: unknown): string;
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
  const then: Any = H.then;
  const ask: Any = H.ask;
  const channels: Any = H.channels;
  const connections = { get: (id: number): Any => H.connectionOf(id) };
  const sectionOfTransport: Any = H.sectionOfTransport;
  const transportsInUse: Any = H.transportsInUse;
  const remoteText: Any = H.remoteText;

  // --- candidates ---------------------------------------------------------------

  /** A candidate attribute's fields (RFC 8839, 5.1, with RFC 6544's
   *  `tcptype`), or null where it is not one or a field is no value its
   *  attribute can hold, which leaves every parsed attribute null (WebRTC
   *  1.0, "create an RTCIceCandidate"). The SDP framing's `a=` is let
   *  through, as every browser lets it. The ufrag extension is `ufrag`,
   *  which only the stack's own candidates are read for. With `fromStack`,
   *  the stack's own: a peer-reflexive candidate it learned from a check
   *  is written with no related address, since it was derived from none
   *  the agent knows. */
  const parseCandidate = (text: string, fromStack = false): Any => {
    let line = text.replace(/\r?\n$/, '');
    if (line.startsWith('a=')) line = line.slice(2);
    if (!line.startsWith('candidate:')) return null;
    const t = line.slice('candidate:'.length).split(' ');
    if (t.length < 8 || t.some((x: string) => x === '')) return null;
    const [foundation, componentId, transport, priorityText, address] = t;
    // foundation = 1*32 ice-char, ice-char = ALPHA / DIGIT / "+" / "/"
    if (!/^[A-Za-z0-9+/]{1,32}$/.test(foundation)) return null;
    // component-id = 1*3 DIGIT, 1 to 256 by RFC 8445's prose; RTP's or
    // RTCP's, as RTCIceComponent has them
    if (!/^[0-9]{1,3}$/.test(componentId)) return null;
    const component = Number(componentId);
    if (component !== 1 && component !== 2) return null;
    const protocol = transport.toLowerCase();
    if (protocol !== 'udp' && protocol !== 'tcp') return null;
    // priority = 1*10 DIGIT, 1 to 2^31 - 1
    if (!/^[0-9]{1,10}$/.test(priorityText)) return null;
    const priority = Number(priorityText);
    if (priority < 1 || priority > 2147483647) return null;
    const portOf = (value: string | undefined): number | null =>
      value !== undefined &&
      /^[0-9]{1,5}$/.test(value) &&
      Number(value) <= 65535
        ? Number(value)
        : null;
    const port = portOf(t[5]);
    if (port === null || t[6].toLowerCase() !== 'typ') return null;
    const type = t[7].toLowerCase();
    if (!['host', 'srflx', 'prflx', 'relay'].includes(type)) return null;
    let i = 8;
    let relatedAddress: string | null = null;
    let relatedPort: number | null = null;
    if (t[i]?.toLowerCase() === 'raddr') {
      if (t[i + 1] === undefined) return null;
      relatedAddress = t[i + 1];
      i += 2;
    }
    if (t[i]?.toLowerCase() === 'rport') {
      relatedPort = portOf(t[i + 1]);
      if (relatedPort === null) return null;
      i += 2;
    }
    // what is not a host is reached from a related address (RFC 8839, 5.1)
    if (
      type !== 'host' &&
      (relatedAddress === null || relatedPort === null) &&
      !(fromStack && type === 'prflx')
    )
      return null;
    // a TCP candidate says its type first (RFC 6544, 4.5)
    let tcpType: string | null = null;
    if (t[i]?.toLowerCase() === 'tcptype') {
      tcpType = t[i + 1]?.toLowerCase() ?? '';
      if (!['active', 'passive', 'so'].includes(tcpType)) return null;
      i += 2;
    } else if (protocol === 'tcp' && type !== 'relay') return null;
    let ufrag: string | null = null;
    // extension-att-name SP extension-att-value, in pairs
    if ((t.length - i) % 2 !== 0) return null;
    for (; i < t.length; i += 2) if (t[i] === 'ufrag') ufrag = t[i + 1];
    return {
      foundation,
      component: component === 1 ? 'rtp' : 'rtcp',
      protocol,
      priority,
      address,
      port,
      type,
      tcpType,
      relatedAddress,
      relatedPort,
      ufrag,
    };
  };

  /** Web IDL's `unsigned short`, with no `[EnforceRange]`. */
  const unsignedShort = (value: Any): number => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) & 0xffff : 0;
  };
  const RELAY_PROTOCOLS = ['udp', 'tcp', 'tls'];

  /** An `RTCIceCandidateInit` as Web IDL converts it: an inherited
   *  dictionary's members first, each dictionary's in their order. With
   *  `local`, `RTCLocalIceCandidateInit`'s `relayProtocol` and `url`. */
  const iceInitOf = (value: Any, local = false): Any => {
    const i = dictionary(value, 'RTCIceCandidateInit');
    const candidate = i.candidate;
    const sdpMLineIndex = i.sdpMLineIndex;
    const sdpMid = i.sdpMid;
    const usernameFragment = i.usernameFragment;
    const out: Any = {
      // a `DOMString`, not nullable: null is "null"
      candidate: candidate === undefined ? '' : String(candidate),
      sdpMLineIndex:
        sdpMLineIndex === undefined || sdpMLineIndex === null
          ? null
          : unsignedShort(sdpMLineIndex),
      sdpMid: sdpMid === undefined || sdpMid === null ? null : String(sdpMid),
      usernameFragment:
        usernameFragment === undefined || usernameFragment === null
          ? null
          : String(usernameFragment),
      relayProtocol: null,
      url: null,
    };
    if (local) {
      const relayProtocol = i.relayProtocol;
      const url = i.url;
      if (relayProtocol !== undefined && relayProtocol !== null) {
        out.relayProtocol = String(relayProtocol);
        if (!RELAY_PROTOCOLS.includes(out.relayProtocol)) {
          throw typeError(
            `The provided value '${out.relayProtocol}' is not a valid enum value of type RTCIceServerTransportProtocol.`,
          );
        }
      }
      if (url !== undefined && url !== null) {
        // a `USVString`: a lone surrogate is U+FFFD
        out.url = String(url).replace(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
          '\uFFFD',
        );
      }
    }
    return out;
  };

  class RTCIceCandidate {
    constructor(init: Any = {}) {
      const i = iceInitOf(init, true);
      const candidate: string = i.candidate;
      const sdpMid: string | null = i.sdpMid;
      const sdpMLineIndex: number | null = i.sdpMLineIndex;
      if (sdpMid === null && sdpMLineIndex === null) {
        throw typeError(
          "Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null.",
        );
      }
      const fields = candidate === '' ? null : parseCandidate(candidate);
      const usernameFragment = i.usernameFragment;
      apply(wmSet, slots, [
        this,
        {
          iceCandidate: true,
          candidate,
          sdpMid,
          sdpMLineIndex,
          usernameFragment,
          fields,
          relayProtocol: i.relayProtocol,
          url: i.url,
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
      if (arguments.length < 1) {
        throw typeError(
          "Failed to construct 'RTCPeerConnectionIceEvent': 1 argument required, but only 0 present.",
        );
      }
      const i = dictionary(init, 'RTCPeerConnectionIceEventInit');
      const candidate = i.candidate ?? null;
      if (
        candidate !== null &&
        !(
          typeof candidate === 'object' &&
          apply(wmGet, slots, [candidate])?.iceCandidate
        )
      ) {
        throw typeError(
          "Failed to construct 'RTCPeerConnectionIceEvent': candidate is not of type 'RTCIceCandidate'.",
        );
      }
      super(type, i);
      apply(wmSet, slots, [
        this,
        {
          iceEvent: true,
          candidate,
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
      const ice = slotOf(this, 'iceTransport');
      const pair = ice.state.selectedPair;
      if (!pair) return null;
      const out = new RTCIceCandidatePair(TOKEN);
      apply(wmSet, slots, [
        out,
        {
          candidatePair: true,
          local: candidateFrom(pair.local),
          remote: remoteCandidateFrom(pair.remote, ice),
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
    t = { id, ice, dtls, state: { ...NEW_TRANSPORT }, queued: null };
    apply(wmSet, slots, [
      ice,
      { iceTransport: true, state: t.state, local: [], remote: [], pc: s },
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
    // with `max-bundle` every m-section rides the first one's transport,
    // which alone gathers, so the others list no candidates (RFC 8843, 7.1.2)
    if (s.config?.bundlePolicy === 'max-bundle') {
      const parts = sdp.split(/(?=^m=)/m);
      sdp = parts
        .map((part, i) =>
          i < 2
            ? part
            : part.replace(
                /^a=(candidate:|end-of-candidates)[^\r\n]*(\r?\n)?/gm,
                '',
              ),
        )
        .join('');
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

  /** A candidate of the stack's: its ufrag where the stack gave none is
   *  the one its string names. */
  const candidateFrom = (c: Any): Any =>
    new RTCIceCandidate({
      candidate: c.candidate,
      sdpMid: c.sdpMid ?? '0',
      sdpMLineIndex: c.sdpMLineIndex,
      usernameFragment:
        c.usernameFragment ?? parseCandidate(c.candidate)?.ufrag ?? null,
    });

  /**
   * A selected pair's remote candidate as the page may see it. One the agent
   * learned from a connectivity check (peer-reflexive), at an address the
   * page never signalled, is the empty string, and its address and related
   * address null; one at an address it did signal is that candidate: what the page was not told, it does not learn from the
   * pair (WebRTC 1.0, RTCIceCandidatePair; WPT's `candidate-exchange`). Its
   * other fields are what the agent knows of it, and a related port it has
   * none of is 0.
   */
  const remoteCandidateFrom = (c: Any, ice: Any): Any => {
    const fields = parseCandidate(c.candidate, true);
    if (fields?.type !== 'prflx') return candidateFrom(c);
    // one the page signalled since, trickled or in a description, is the
    // candidate it signalled
    const at = (f: Any): boolean =>
      !!f && f.address === fields.address && f.port === fields.port;
    const trickled = ice.remote.find((k: Any) =>
      at(apply(wmGet, slots, [k])?.fields),
    );
    if (trickled) return new RTCIceCandidate(trickled.toJSON());
    for (const line of String(remoteText(ice.pc)).split(/\r?\n/)) {
      if (!line.startsWith('a=candidate:')) continue;
      if (!at(parseCandidate(line.slice(2)))) continue;
      return new RTCIceCandidate({
        candidate: line.slice(2),
        sdpMid: c.sdpMid ?? '0',
        sdpMLineIndex: c.sdpMLineIndex,
      });
    }
    const out = new RTCIceCandidate({
      candidate: '',
      sdpMid: c.sdpMid ?? '0',
      sdpMLineIndex: c.sdpMLineIndex,
      usernameFragment: null,
    });
    apply(wmGet, slots, [out]).fields = {
      ...fields,
      address: null,
      relatedAddress: null,
      relatedPort: fields.relatedPort ?? 0,
      ufrag: null,
    };
    return out;
  };

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
    // its `length` is 1, as a maplike's is: the second is optional
    forEach(fn: Any, ...rest: Any[]): void {
      const thisArg = rest[0];
      for (const [k, v] of slotOf(this, 'report').map)
        fn.call(thisArg, v, k, this);
    }
  }
  // a maplike's @@iterator is its entries (Web IDL, 3.7.11)
  Object.defineProperty(RTCStatsReport.prototype, Symbol.iterator, {
    value: RTCStatsReport.prototype.entries,
    writable: true,
    configurable: true,
  });
  const reportOf = (list: Any[]): Any => {
    const report = new RTCStatsReport(TOKEN);
    const map = new Map();
    for (const s of list ?? [])
      if (s && s.id !== undefined) map.set(String(s.id), s);
    apply(wmSet, slots, [report, { report: true, map }]);
    return report;
  };
  /** An inbound-rtp's `trackIdentifier` is the id of the receiver's track,
   *  which the host cannot know: the realm made it. Found by the stream's
   *  mid, which the host names it with. */
  const withTracks = (pc: Any, list: Any[]): Any[] => {
    for (const s of list ?? []) {
      if (!s || s.type !== 'inbound-rtp' || s.mid == null) continue;
      for (const t of pc.transceivers) {
        const ts = apply(wmGet, slots, [t]);
        if (!ts || ts.mid !== s.mid) continue;
        const track = apply(wmGet, slots, [ts.receiver])?.track;
        if (track) s.trackIdentifier = track.id;
        break;
      }
    }
    return list;
  };
  /** `getStats()`, a sender's and a receiver's: a closed connection's too,
   *  since WebRTC 1.0 no longer refuses one (8.2). */
  const statsOf = (pc: Any, tx: Any, side: string): Promise<Any> => {
    return then(
      ask((req: number) =>
        call('rtcStats', pc.id, req, side, tx ? tx.id : null),
      ),
      (list: Any) => reportOf(withTracks(pc, list)),
    );
  };

  // --- what a connection works out from its transports ----------------------

  /** The aggregate states, worked out again from the transports in use, and
   *  told where they moved (WebRTC 1.0, 4.3.2 and 4.3.3). */
  const updateStates = (s: Any): void => {
    moveStates(s)();
  };

  /** The aggregate states worked out again and set, and what tells the
   *  page they moved: a transport's state is set, then the connection's,
   *  then the transport's event fires and the connection's after it, so a
   *  handler of either reads both as they are now (WebRTC 1.0, 4.3.2;
   *  webrtc-pc#2894 for gathering). */
  const moveStates = (s: Any): (() => void) => {
    const told: (() => void)[] = [];
    const tell = () => {
      for (const f of told) if (!s.closed) f();
    };
    if (s.closed) return tell;
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
      told.push(() => {
        simple(s.self, 'icegatheringstatechange');
        if (gatherState === 'complete') {
          fire(
            s.self,
            new RTCPeerConnectionIceEvent('icecandidate', { candidate: null }),
          );
        }
      });
    }
    if (iceState !== s.iceState) {
      s.iceState = iceState;
      told.push(() => simple(s.self, 'iceconnectionstatechange'));
    }
    if (connState !== s.connState) {
      s.connState = connState;
      told.push(() => simple(s.self, 'connectionstatechange'));
    }
    return tell;
  };

  // --- what the host tells ---------------------------------------------------

  // a transport moved: its objects' events, then the connection's
  entry('__rtcTransport', () => {
    const [pcId, id, state] = input() as [number, number, TransportState];
    const s = connections.get(pcId);
    if (!s || s.closed) return null;
    const t = transportOf(s, id);
    // what is told while the end of its gathering waits for its task waits
    // behind it, or it is read against the state before that end and
    // ends the gathering again: a stack that tells the transport three
    // times in that task, its pair or its roles moving, had the page hear
    // three ends of candidates and three gatheringstatechanges
    if (t.queued) t.queued.push(state);
    else transportArrived(s, t, id, state);
    return null;
  });

  /** A transport's new state, read against the one it has: the end of its
   *  candidates, then, in a task of its own, what its gathering coming to
   *  an end changes (webrtc-pc#2894), and the states told meanwhile. */
  const transportArrived = (
    s: Any,
    t: Any,
    id: number,
    state: TransportState,
  ): void => {
    const before: TransportState = t.state;
    if (
      before.gatheringState === 'complete' ||
      state.gatheringState !== 'complete'
    ) {
      transportMoved(s, t, before, state);
      return;
    }
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
    t.queued = [] as TransportState[];
    setTimer(() => {
      const waiting: TransportState[] = t.queued;
      t.queued = null;
      if (s.closed) return;
      transportMoved(s, t, before, state);
      for (const next of waiting) {
        if (s.closed) return;
        if (t.queued) t.queued.push(next);
        else transportArrived(s, t, id, next);
      }
    }, 0);
  };

  const transportMoved = (
    s: Any,
    t: Any,
    before: TransportState,
    state: TransportState,
  ): void => {
    setTransportState(t, state);
    const connection = moveStates(s);
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
    connection();
  };

  // a candidate was gathered: its transport has it, then the page hears it
  entry('__rtcCandidate', () => {
    const [pcId, id, c] = input() as [number, number, Any];
    const s = connections.get(pcId);
    if (!s || s.closed) return null;
    const candidate = candidateFrom(c);
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
