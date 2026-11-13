// Where werift's codec negotiation differs from a browser's, and what the
// adapter (`./werift.ts`) does about each. Three are werift's choices of
// codecs, made inside its transceiver manager, so the adapter narrows or
// widens what werift made there (`keepPreferredCodecs`) or around its
// `createOffer` (`reofferCodecs`); the rest is the remote SDP, which is put
// as werift reads it before it is handed over (`asWeriftReads`).
// docs/prd-webrtc.md has the table, with the werift issue for each.
//
// None of it changes an offer that nothing asked to change: a transceiver
// with no codec preferences offers what `OFFERED_CODECS` lists, rtx paired
// in an `a=ssrc-group:FID` as Meet reads it (`./rtc-codecs.ts`).

import type { RTCCodecLike } from './rtc.js';

/** A werift codec, the slice read here. */
export interface WCodecLike {
  payloadType?: number;
  mimeType: string;
  clockRate: number;
  channels?: number;
  parameters?: string;
  rtcpFeedback?: unknown[];
}

/** What of a werift transceiver its codecs are resolved on. */
interface ResolvedTransceiver {
  codecs: WCodecLike[];
}

const nameOf = (c: { mimeType: string }): string =>
  c.mimeType.toLowerCase().split('/')[1] ?? '';

/** Codecs that carry another codec's media, which name it as theirs. */
const AUXILIARY = new Set(['rtx', 'red', 'ulpfec', 'flexfec-03']);

/** The payload type an rtx's `apt` names, or null. */
function aptOf(c: WCodecLike): number | null {
  const m = /(?:^|;)\s*apt=(\d+)/.exec(c.parameters ?? '');
  return m ? Number(m[1]) : null;
}

/** The payload types a codec carries the media of: an rtx's `apt`, a
 *  red's `a/b`; none for ulpfec, which protects whatever it is sent with. */
function carries(c: WCodecLike): number[] {
  const name = nameOf(c);
  if (name === 'rtx') {
    const apt = aptOf(c);
    return apt === null ? [] : [apt];
  }
  if (name === 'red') {
    return (c.parameters ?? '')
      .split('/')
      .map(Number)
      .filter((n) => !Number.isNaN(n));
  }
  return [];
}

/** Whether two codecs are the same media format, payload type apart. */
function sameFormat(a: RTCCodecLike | WCodecLike, b: WCodecLike): boolean {
  return (
    a.mimeType.toLowerCase() === b.mimeType.toLowerCase() &&
    a.clockRate === b.clockRate &&
    (a.channels ?? 1) === (b.channels ?? 1)
  );
}

/** Each werift transceiver's codec preferences, as the page set them: what
 *  `narrowToPreferences` holds werift's codecs to. */
const PREFERRED = new WeakMap<object, RTCCodecLike[]>();

/** `setCodecPreferences`, already checked: an empty list is none. */
export function notePreferences(t: object, codecs: RTCCodecLike[]): void {
  if (codecs.length) PREFERRED.set(t, codecs);
  else PREFERRED.delete(t);
}

/**
 * werift's codecs held to a transceiver's preferences, as a browser holds
 * them (WebRTC 1.0, 5.4 `setCodecPreferences`; JSEP 5.2.1, 5.3.1): a media
 * codec only if a preference names its format, and an rtx, a red or a
 * ulpfec only if a preference names its kind and every codec it carries is
 * kept. werift 0.26 matches a preference by its MIME type and clock rate
 * alone, so every rtx preference is the first rtx configured, the one at
 * apt=96, and it keeps the codec a preferred rtx carries: preferences of
 * every video codec but VP8 kept VP8, through `rtx apt=96`. And it adds back
 * every rtx whose codec is kept, so no preference list took rtx out. The
 * order is werift's, which is the preferences' (`applyCodecPreferences`).
 */
export function narrowToPreferences(
  codecs: WCodecLike[],
  preferences: RTCCodecLike[] | undefined,
): WCodecLike[] {
  if (!preferences?.length) return codecs;
  const kinds = new Set(preferences.map(nameOf));
  const media = codecs.filter(
    (c) =>
      !AUXILIARY.has(nameOf(c)) &&
      preferences.some((p) => !AUXILIARY.has(nameOf(p)) && sameFormat(p, c)),
  );
  // what nothing would carry the media of is no answer: werift's own
  if (media.length === 0) return codecs;
  const kept = new Set(media.map((c) => c.payloadType));
  return codecs.filter((c) => {
    const name = nameOf(c);
    if (!AUXILIARY.has(name)) return media.includes(c);
    if (!kinds.has(name)) return false;
    return carries(c).every((pt) => kept.has(pt));
  });
}

/** werift's transceiver manager, the methods that resolve a transceiver's
 *  codecs: for an offer, for an answer, and for a remote offer as it is
 *  set, which an answer is made from where nothing changed since. */
interface WTransceiverManager {
  assignTransceiverCodecs(t: ResolvedTransceiver): void;
  refreshAnswerCodecs(t: ResolvedTransceiver, remote: unknown): void;
  planRemoteRtpCodecs(
    remote: { type?: string },
    find: (media: unknown, index: number) => object | undefined,
  ): Map<number, WCodecLike[]>;
}

/**
 * Holds what werift resolves a connection's transceivers' codecs to — for
 * an offer, and for an answer to a remote offer — to the page's
 * preferences (`narrowToPreferences`). The adapter reaches into werift's
 * transceiver manager for it: werift has no public way to say which rtx a
 * preference means. A werift without the methods is left as it is.
 */
export function keepPreferredCodecs(pc: unknown): void {
  const tm = (pc as { transceiverManager?: WTransceiverManager })
    .transceiverManager;
  if (
    !tm ||
    typeof tm.assignTransceiverCodecs !== 'function' ||
    typeof tm.refreshAnswerCodecs !== 'function' ||
    typeof tm.planRemoteRtpCodecs !== 'function'
  )
    return;
  const assign = tm.assignTransceiverCodecs;
  const refresh = tm.refreshAnswerCodecs;
  const plan = tm.planRemoteRtpCodecs;
  tm.planRemoteRtpCodecs = function (remote, find) {
    const found = new Map<number, object | undefined>();
    const planned = plan.call(this, remote, (media, index) => {
      const t = find(media, index);
      found.set(index, t);
      return t;
    });
    if (remote?.type !== 'offer') return planned;
    for (const [index, codecs] of planned) {
      const t = found.get(index);
      if (t && codecs.length) {
        planned.set(index, narrowToPreferences(codecs, PREFERRED.get(t)));
      }
    }
    return planned;
  };
  tm.assignTransceiverCodecs = function (t) {
    assign.call(this, t);
    t.codecs = narrowToPreferences(t.codecs, PREFERRED.get(t));
  };
  tm.refreshAnswerCodecs = function (t, remote) {
    refresh.call(this, t, remote);
    t.codecs = narrowToPreferences(t.codecs, PREFERRED.get(t));
  };
}

/** The payload types an m-section may give a codec, in the order a free
 *  one is taken: the dynamic range, then the low one Chrome uses. */
function* dynamicTypes(): Generator<number> {
  for (let pt = 96; pt <= 127; pt++) yield pt;
  for (let pt = 35; pt <= 63; pt++) yield pt;
}

/**
 * A subsequent offer's codecs (JSEP 5.2.2, RFC 8829): what the last
 * negotiation kept, at the payload types it kept them at, then every other
 * codec the transceiver supports — `full`, as an initial offer has them —
 * with a payload type no other codec has, each rtx carrying its codec's
 * payload type here. werift 0.26 offers the negotiated codecs alone, so a
 * connection could never move to a codec the first answer left out
 * (werift#818). `make` copies a codec at another payload type.
 */
export function reofferCodecs(
  negotiated: WCodecLike[],
  full: WCodecLike[],
  make: (c: WCodecLike, payloadType: number, parameters?: string) => WCodecLike,
): WCodecLike[] {
  const out = [...negotiated];
  const used = new Set(out.map((c) => c.payloadType));
  const free = (wanted: number | undefined): number | null => {
    if (wanted !== undefined && !used.has(wanted)) return wanted;
    for (const pt of dynamicTypes()) if (!used.has(pt)) return pt;
    return null;
  };
  // each media codec of `full`, at the payload type it has in `out`
  const here = new Map<number | undefined, number>();
  for (const c of full) {
    if (AUXILIARY.has(nameOf(c))) continue;
    const match = out.find(
      (n) => !AUXILIARY.has(nameOf(n)) && sameFormat(c, n),
    );
    if (match?.payloadType !== undefined) {
      here.set(c.payloadType, match.payloadType);
      continue;
    }
    const pt = free(c.payloadType);
    if (pt === null) continue;
    used.add(pt);
    out.push(pt === c.payloadType ? c : make(c, pt));
    here.set(c.payloadType, pt);
  }
  for (const c of full) {
    if (nameOf(c) !== 'rtx') continue;
    const apt = aptOf(c);
    const target = apt === null ? undefined : here.get(apt);
    if (target === undefined) continue;
    if (out.some((n) => nameOf(n) === 'rtx' && aptOf(n) === target)) continue;
    const pt = free(c.payloadType);
    if (pt === null) continue;
    used.add(pt);
    out.push(
      pt === c.payloadType && apt === target
        ? c
        : make(c, pt, (c.parameters ?? '').replace(/apt=\d+/, `apt=${target}`)),
    );
  }
  return out;
}

/** The payload types RFC 3551 gives a format, which an m-section may list
 *  with no `a=rtpmap`. */
const STATIC_TYPES: Record<string, Record<number, string>> = {
  audio: {
    0: 'PCMU/8000',
    3: 'GSM/8000',
    4: 'G723/8000',
    8: 'PCMA/8000',
    9: 'G722/8000',
    13: 'CN/8000',
    18: 'G729/8000',
  },
  video: {
    26: 'JPEG/90000',
    31: 'H261/90000',
    32: 'MPV/90000',
    34: 'H263/90000',
  },
};

/**
 * A remote description as werift reads it: each m-section with an
 * `a=rtpmap` for a static payload type it lists with none, and its
 * `a=rtpmap` lines in the order its m-line lists the formats. werift knows
 * a codec only by its `a=rtpmap`, so `m=audio … 111 0` with no
 * `a=rtpmap:0` negotiated no PCMU; and it puts a remote answer's codecs in
 * the order of the `a=rtpmap` lines, where the m-line's is the answerer's
 * preference (RFC 3264, 6.1). A description whose sections are as werift
 * reads them comes back as it is, which a browser's always does.
 */
export function asWeriftReads(sdp: string): string {
  const lines = sdp.split('\r\n');
  let changed = false;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^m=(\w+) \S+ \S+((?: \S+)*)$/.exec(line);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end].startsWith('m=')) end++;
    const section = lines.slice(i, end);
    const formats = m[2].trim().split(' ').filter(Boolean);
    const shaped = shapeSection(section, m[1], formats);
    if (shaped !== section) changed = true;
    out.push(...shaped);
    i = end;
  }
  return changed ? out.join('\r\n') : sdp;
}

function shapeSection(
  section: string[],
  kind: string,
  formats: string[],
): string[] {
  const rtpmapOf = (l: string): string | null =>
    /^a=rtpmap:(\d+) /.exec(l)?.[1] ?? null;
  const mapped = new Set(section.map(rtpmapOf).filter((x) => x !== null));
  const statics = STATIC_TYPES[kind] ?? {};
  const added = formats
    .filter((f) => !mapped.has(f) && statics[Number(f)])
    .map((f) => `a=rtpmap:${f} ${statics[Number(f)]}`);
  const rtpmaps = section.filter((l) => rtpmapOf(l) !== null);
  const rank = (l: string): number => {
    const at = formats.indexOf(rtpmapOf(l)!);
    return at < 0 ? formats.length : at;
  };
  const sorted = [...rtpmaps, ...added].sort((a, b) => rank(a) - rank(b));
  if (!added.length && sorted.every((l, k) => l === rtpmaps[k])) return section;
  // the rtpmaps, in format order, where the first of them was; added ones
  // after the m-line's own attributes where there were none
  const first = section.findIndex((l) => rtpmapOf(l) !== null);
  const rest = section.filter((l) => rtpmapOf(l) === null);
  // nothing before the first rtpmap is one, so it stands at the same index
  // in what is left
  const at = first < 0 ? lastNonEmpty(rest) + 1 : first;
  return [...rest.slice(0, at), ...sorted, ...rest.slice(at)];
}

function lastNonEmpty(lines: string[]): number {
  for (let k = lines.length - 1; k >= 0; k--) if (lines[k] !== '') return k;
  return 0;
}
