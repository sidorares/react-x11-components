// The host's half of a `MediaSource` of fragmented MP4 (`mse.ts`): what a
// page appends kept as MSE's track buffers, and handed to the platform's
// player as an HLS stream it reads over loopback (`loopback.ts`), a few
// seconds at a time as the page appends them.
//
// **The player opens a URL, and HLS is a URL that grows.** AVFoundation reads
// fragmented MP4 a segment at a time from a playlist, and a playlist that is
// still being written (`EXT-X-PLAYLIST-TYPE:EVENT`) is one it reloads for
// more. So what a page appends is cut into segments as it arrives, and each
// is listed once it is whole. The page's bytes are not handed on as they
// came: a page appends what its network hands it, a segment of YouTube's in
// pieces of ten kilobytes, and the player is handed segments of its own, cut
// from the frames (`fmp4.ts`), with timestamps that start where the playlist
// starts.
//
// Five things about AVFoundation decide the shape, each found by playing a
// playlist to it (docs/components/html.md):
//
//  - **It will not start, seek or go on within three target durations of the
//    end of a playlist that is still growing**, and refuses a `HOLD-BACK`
//    shorter than that ("Cannot Open"). So segments are short — two seconds,
//    cut inside a GOP where one is longer — and need not start at a key
//    frame: it decodes across them, and seeks into one, correctly.
//  - **It waits a whole target duration for the next playlist**, unless the
//    server says it can block (`CAN-BLOCK-RELOAD`), when it asks for the
//    next segment (`_HLS_msn`) and takes it the moment it is listed.
//  - **A blocked reload is held until there is something to answer it
//    with.** Answered with the playlist it had, a player at the end of what
//    was listed failed (`-15416`) or said it had ended; held, it gives up
//    after eight seconds, asks again and waits, for as long as the page
//    appends nothing.
//  - **It starts where the first playlist it reads says the end is**, a
//    few segments back, whatever `EXT-X-START` says, in the master or in the
//    media playlist. YouTube appends twenty seconds in half a second, and
//    the player started fourteen in. So a session's first media playlist
//    lists two segments (`HEAD_START`), and the player is told the rest at
//    its next reload, which it asks for at once; it is sought to where the
//    page is, which is past the key frame the session starts at.
//  - **A new `EXT-X-MAP` is enough for another quality**: YouTube's 480p to
//    720p plays across one, with no discontinuity.
//
// So a page's seek far from what the player has starts a session of its
// own: a playlist that starts at the key frame before where the page went,
// handed to a new player. A seek inside what the player has, far enough from
// its end, is the player's (`Feed.seek`).
//
// **The bytes stay here.** Only sizes, times and ranges cross to the page's
// realm, as for a clip (`clips.ts`).

import type { Element } from 'domhandler';

import { Fmp4Reader, initSegment, mediaSegment } from './fmp4.js';
import type { Fmp4Track, SegmentSample } from './fmp4.js';

/** A segment's longest, in seconds: the playlist's target duration. */
export const TARGET = 2;
/** A segment ends before a key frame once it is this long, so that the next
 *  starts where a decoder can. */
const AT_KEY = 1;
/** How much a session lists before the player is handed it, in seconds. */
const BEFORE_PLAYER = 4;
/** How many segments the first playlist the player reads of each kind
 *  lists, from the one it is to start in: few enough that it starts at the
 *  first, where with more it starts three target durations from the end. */
const HEAD_START = 2;
/** How far behind where the player is a segment keeps its frames, in
 *  seconds: further back, a request for one is refused, and a seek there is
 *  a session of its own. */
const KEEP_BEHIND = 30;
/** Chrome's quotas for a `SourceBuffer`, in bytes: past them, what is
 *  before the current position goes, and then an append is refused. */
const VIDEO_QUOTA = 150 << 20;
const AUDIO_QUOTA = 12 << 20;
/** How many times a session may fail its player before the element fails. */
const MOST_FAILURES = 3;
/** How late what is buffered may start after where the page is, in seconds,
 *  for a session to start there: a stream's first frame is often a frame or
 *  two in. */
const START_SLACK = 0.5;

type Kind = 'video' | 'audio';

/** The codecs a feed takes, as RFC 6381 names them: H.264 and AAC, which
 *  the player decodes in HLS's fragmented MP4. */
const VIDEO_CODEC = /^avc[13](?:\.[0-9a-f]{6}|\.\d+\.\d+)?$/i;
const AUDIO_CODEC = /^mp4a(?:\.40\.0?(?:2|5|29)|\.40)?$/i;

/** A MIME type's essence and parameters, quoted values unquoted. */
function parseType(type: string): {
  essence: string;
  params: Map<string, string>;
} {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of type) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  const params = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    params.set(name, value);
  }
  return { essence: parts[0].trim().toLowerCase(), params };
}

/**
 * Whether a feed takes a `SourceBuffer` of `type`: MP4 whose codecs are all
 * H.264 or AAC, and none at all, which Chrome takes too. Its other
 * parameters — `width`, `bitrate`, YouTube's `decode-to-texture` — are no
 * part of the answer, as they are none of Chrome's.
 */
export function feedTakes(type: string): boolean {
  const { essence, params } = parseType(type);
  if (essence !== 'video/mp4' && essence !== 'audio/mp4') return false;
  const codecs = params.get('codecs');
  if (codecs === undefined) return true;
  const list = codecs
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (!list.length) return false;
  return list.every(
    (c) =>
      AUDIO_CODEC.test(c) || (essence === 'video/mp4' && VIDEO_CODEC.test(c)),
  );
}

/** A sample entry a track's frames were appended under. */
interface Config {
  /** Which it is of the feed's, for its `EXT-X-MAP`. */
  id: number;
  track: Fmp4Track;
}

/** A coded frame, in seconds of the page's timeline. */
interface Frame {
  pts: number;
  dts: number;
  duration: number;
  sync: boolean;
  data: Uint8Array;
  config: Config;
}

/** How far apart two frames may be in decode time and still follow on. */
const following = (prev: Frame, next: Frame): boolean =>
  Math.abs(next.dts - (prev.dts + prev.duration)) <=
  Math.max(prev.duration / 2, 0.001);

/** The first of `frames` whose decode time is at least `dts`, less half a
 *  millisecond. */
function atDecode(frames: Frame[], dts: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (frames[mid].dts < dts - 0.0005) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** MSE's track buffer (3.5.8): a track's coded frames in decode order. */
class TrackBuffer {
  frames: Frame[] = [];
  bytes = 0;
  /** MSE's "last decode timestamp", null where it is unset. */
  lastDts: number | null = null;
  lastDuration = 0;
  /** MSE's "highest end timestamp". */
  highestEnd: number | null = null;
  /** MSE's "need random access point flag". */
  needKey = true;
  /** Where the frames' presentations end, at most. */
  private _end = -Infinity;
  /** How far before its decode a frame presents, at most. */
  private _lag = 0;
  private _longest = 0;
  private _ranges: [number, number][] | null = [];

  constructor(readonly kind: Kind) {}

  /** A new coded frame group: what follows is not taken to follow on. */
  resetGroup(): void {
    this.lastDts = null;
    this.lastDuration = 0;
    this.highestEnd = null;
    this.needKey = true;
  }

  /** MSE 3.5.8, steps 13 to 18: what the frame overlaps goes, with what
   *  decodes from it, and the frame goes in. */
  add(frame: Frame): void {
    const end = frame.pts + frame.duration;
    if (this.highestEnd === null) {
      // step 14: a video frame whose presentation the new one starts in
      // goes, a microsecond's leeway, and step 15 the frames in it
      this._removeWhere(
        frame.pts - this._longest,
        end,
        (f) =>
          (f.pts >= frame.pts && f.pts < end) ||
          (this.kind === 'video' &&
            f.pts < frame.pts &&
            frame.pts < f.pts + f.duration &&
            frame.pts < f.pts + 0.000001),
      );
    } else if (this._end > this.highestEnd) {
      const from = this.highestEnd;
      this._removeWhere(from, end, (f) => f.pts >= from && f.pts < end);
    }
    const last = this.frames[this.frames.length - 1];
    if (!last || frame.dts > last.dts) {
      this.frames.push(frame);
      this._grow(frame);
    } else {
      this.frames.splice(atDecode(this.frames, frame.dts), 0, frame);
      this._ranges = null;
    }
    this.bytes += frame.data.length;
    this._end = Math.max(this._end, end);
    this._lag = Math.max(this._lag, frame.pts - frame.dts);
    this._longest = Math.max(this._longest, frame.duration);
    this.lastDts = frame.dts;
    this.lastDuration = frame.duration;
    this.highestEnd = Math.max(this.highestEnd ?? -Infinity, end);
  }

  /** MSE 3.5.9's range removal: what presents from `start` until `end`
   *  goes, and for video until the next random access point after it, with
   *  what decodes from what went. */
  remove(start: number, end: number): void {
    let until = end;
    if (this.kind === 'video') {
      until = Infinity;
      for (const f of this.frames) {
        if (f.sync && f.pts >= end && f.pts < until) until = f.pts;
      }
    }
    this._removeWhere(start, until, (f) => f.pts >= start && f.pts < until);
  }

  /** The frames `test` picks, between `from` and `to` in presentation, go,
   *  and every frame after one of them in decode order until a key frame. */
  private _removeWhere(
    from: number,
    to: number,
    test: (f: Frame) => boolean,
  ): void {
    if (!this.frames.length || to <= from - this._lag) return;
    const first = Number.isFinite(from)
      ? atDecode(this.frames, from - this._lag - this._longest)
      : 0;
    let removing = false;
    let any = false;
    const kept: Frame[] = this.frames.slice(0, first);
    for (let i = first; i < this.frames.length; i += 1) {
      const f = this.frames[i];
      if (f.sync) removing = false;
      if (test(f)) removing = true;
      if (removing) {
        any = true;
        this.bytes -= f.data.length;
        continue;
      }
      kept.push(f);
    }
    if (!any) return;
    this.frames = kept;
    this._ranges = null;
    this._end = -Infinity;
    for (const f of kept) this._end = Math.max(this._end, f.pts + f.duration);
  }

  /** How far apart two presentations may be for `buffered` to run on
   *  between them: twice the longest frame, as Chrome's fudge room is. */
  private _fudge(): number {
    return Math.max(this._longest * 2, 0.001);
  }

  private _grow(frame: Frame): void {
    const ranges = this._ranges;
    if (!ranges) return;
    const start = frame.pts;
    const end = frame.pts + frame.duration;
    const last = ranges[ranges.length - 1];
    const fudge = Math.max(this._fudge(), frame.duration * 2);
    if (!last) {
      ranges.push([start, end]);
    } else if (start >= last[0] - fudge && start <= last[1] + fudge) {
      last[0] = Math.min(last[0], start);
      last[1] = Math.max(last[1], end);
    } else if (start > last[1]) {
      ranges.push([start, end]);
    } else {
      this._ranges = null;
    }
  }

  /** What is buffered, in seconds of presentation (MSE 3.2's `buffered`). */
  ranges(): [number, number][] {
    if (this._ranges) return this._ranges;
    const spans = this.frames
      .map((f): [number, number] => [f.pts, f.pts + f.duration])
      .sort((a, b) => a[0] - b[0]);
    const fudge = this._fudge();
    const out: [number, number][] = [];
    for (const [s, e] of spans) {
      const last = out[out.length - 1];
      if (last && s <= last[1] + fudge) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    this._ranges = out;
    return out;
  }

  /** Whether `time` is buffered, and where what it is in ends. */
  rangeAt(time: number): [number, number] | null {
    for (const r of this.ranges()) {
      if (time >= r[0] - 0.0005 && time < r[1]) return r;
    }
    return null;
  }
}

function intersect(
  a: [number, number][],
  b: [number, number][],
): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]);
    const end = Math.min(a[i][1], b[j][1]);
    if (end > start) out.push([start, end]);
    if (a[i][1] < b[j][1]) i += 1;
    else j += 1;
  }
  return out;
}

/** What an append is told with: the `SourceBuffer`'s attributes, and where
 *  the element's clock is, which what is evicted keeps clear of. */
export interface AppendParams {
  offset: number;
  mode: 'segments' | 'sequence';
  windowStart: number;
  windowEnd: number;
  time: number;
}

/** What an append came to, as the page's realm reads it. */
export interface FeedAnswer {
  ranges: [number, number][];
  /** The stream cannot be read any further. */
  failed?: true;
  /** Its first initialization segment, once it has had one. */
  init?: { width: number; height: number; duration: number | null };
  /** `timestampOffset`, where a `sequence` buffer moved it. */
  offset?: number;
  /** The buffer is too full to take the bytes, and took none of them:
   *  `appendBuffer` throws `QuotaExceededError` (MSE 3.5.10). */
  refused?: true;
}

/** A `SourceBuffer`'s bytes and frames. */
class SourceStore {
  readonly reader = new Fmp4Reader();
  readonly tracks = new Map<Kind, TrackBuffer>();
  /** Which of its kinds each `track_ID` of the last init segment is. */
  private _ids = new Map<number, { kind: Kind; config: Config }>();
  initialized = false;
  /** Where a `sequence` buffer's next group starts. */
  private _groupEnd = 0;

  constructor(readonly feed: Feed) {}

  bytes(): number {
    let n = 0;
    for (const t of this.tracks.values()) n += t.bytes;
    return n;
  }

  /** MSE 3.5.10 and 3.5.8: the bytes read, and each frame they finish
   *  processed. */
  append(bytes: Uint8Array, params: AppendParams): FeedAnswer {
    const out: FeedAnswer = { ranges: [] };
    if (!this._evict(bytes.length, params.time)) {
      return { ranges: this.ranges(), refused: true };
    }
    let offset = params.offset;
    for (const item of this.reader.push(bytes)) {
      if ('init' in item) {
        if (!this._initialize(item.init.tracks, item.init.duration, out)) {
          out.failed = true;
          break;
        }
        continue;
      }
      const sample = item.sample;
      const held = this._ids.get(sample.track);
      if (!held) continue;
      const buffer = this.tracks.get(held.kind)!;
      const scale = held.config.track.timescale;
      if (params.mode === 'sequence' && buffer.lastDts === null) {
        // 3.5.8 step 1.3: a group follows on from where the last ended
        offset = this._groupEnd - sample.pts / scale;
        out.offset = offset;
      }
      const frame: Frame = {
        pts: sample.pts / scale + offset,
        dts: sample.dts / scale + offset,
        duration: sample.duration / scale,
        sync: sample.sync,
        data: sample.data,
        config: held.config,
      };
      // 3.5.8 step 6: a discontinuity starts every track's group again
      if (
        buffer.lastDts !== null &&
        (frame.dts < buffer.lastDts ||
          frame.dts - buffer.lastDts > 2 * buffer.lastDuration)
      ) {
        for (const t of this.tracks.values()) t.resetGroup();
      }
      const end = frame.pts + frame.duration;
      if (frame.pts < params.windowStart || end > params.windowEnd) {
        buffer.needKey = true;
        continue;
      }
      if (buffer.needKey) {
        if (!frame.sync) continue;
        buffer.needKey = false;
      }
      buffer.add(frame);
      this._groupEnd = Math.max(this._groupEnd, end);
    }
    if (this.reader.failed) out.failed = true;
    out.ranges = this.ranges();
    return out;
  }

  private _initialize(
    tracks: Fmp4Track[],
    duration: number | null,
    out: FeedAnswer,
  ): boolean {
    const ids = new Map<number, { kind: Kind; config: Config }>();
    for (const track of tracks) {
      if (track.kind !== 'video' && track.kind !== 'audio') continue;
      if ([...ids.values()].some((t) => t.kind === track.kind)) continue;
      const takes =
        track.kind === 'video'
          ? VIDEO_CODEC.test(track.codec)
          : AUDIO_CODEC.test(track.codec);
      // an encrypted track, and one of another codec, is none the player
      // is handed anything of
      if (!takes) return false;
      ids.set(track.id, {
        kind: track.kind,
        config: this.feed.config(track),
      });
    }
    if (!ids.size) return false;
    if (!this.initialized) {
      this.initialized = true;
      for (const { kind } of ids.values()) {
        this.tracks.set(kind, new TrackBuffer(kind));
      }
      const video = [...ids.values()].find((t) => t.kind === 'video');
      out.init = {
        width: video?.config.track.width ?? 0,
        height: video?.config.track.height ?? 0,
        duration,
      };
    } else {
      // 3.5.7 step 5: the same tracks every time
      const kinds = [...ids.values()].map((t) => t.kind).sort();
      const had = [...this.tracks.keys()].sort();
      if (kinds.join() !== had.join()) return false;
    }
    this._ids = ids;
    return true;
  }

  private _quota(): number {
    return this.tracks.has('video') ? VIDEO_QUOTA : AUDIO_QUOTA;
  }

  /** MSE 3.5.13's coded frame eviction, before an append: what is before
   *  the key frame the clock is past goes, where the bytes would not fit.
   *  False where they still would not. */
  private _evict(incoming: number, time: number): boolean {
    if (this.bytes() + incoming <= this._quota()) return true;
    let before = time;
    const video = this.tracks.get('video');
    if (video) {
      for (const f of video.frames) {
        if (f.sync && f.pts <= time) before = f.pts;
        if (f.pts > time) break;
      }
    }
    if (before > 0) {
      for (const t of this.tracks.values()) t.remove(-Infinity, before);
    }
    return this.bytes() + incoming <= this._quota();
  }

  remove(start: number, end: number): FeedAnswer {
    for (const t of this.tracks.values()) t.remove(start, end);
    return { ranges: this.ranges() };
  }

  /** MSE 3.5's "reset parser state": `abort()`, and a new type. */
  reset(): void {
    this.reader.reset();
    for (const t of this.tracks.values()) t.resetGroup();
  }

  /** A `SourceBuffer`'s `buffered`: what all its tracks have. */
  ranges(): [number, number][] {
    let out: [number, number][] | null = null;
    for (const t of this.tracks.values()) {
      out = out ? intersect(out, t.ranges()) : t.ranges().slice();
    }
    return out ?? [];
  }
}

/** A segment of the player's playlist, which never changes once listed. */
interface Segment {
  /** Where it starts in the session, in seconds, and how long it is. */
  start: number;
  duration: number;
  video?: SegmentTrack;
  audio?: SegmentTrack;
  /** How many bytes it is, for the playlist's bandwidth. */
  bytes: number;
}

interface SegmentTrack {
  config: Config;
  /** Its frames, until the player is far past them. */
  frames: Frame[] | null;
  /** Where the frame after its last decodes, in the page's seconds: its
   *  last frame lasts until then. */
  next: number;
}

/** What a feed's requests are answered with. */
export interface FeedReply {
  status: number;
  type?: string;
  body?: Uint8Array[];
}

const PLAYLIST = 'application/vnd.apple.mpegurl';
const encode = (text: string): Uint8Array[] => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return [out];
};

/** One playlist the player is handed: from a key frame on, as the page
 *  appends what follows it. */
class Session {
  readonly segments: Segment[] = [];
  /** Where the session's time 0 is in the page's: the presentation of its
   *  first frame. */
  readonly origin: number;
  /** And where its first frame decodes, which its decode times start at. */
  readonly decodeOrigin: number;
  /** Where the next video frame decodes, and the next audio frame shows. */
  videoNext: number;
  audioNext: number;
  /** Where in the session the player is to start. */
  readonly startAt: number;
  /** Listed `EXT-X-ENDLIST`: the page ended its stream. */
  ended = false;
  /** Handed to the player. */
  shown = false;
  /** Where the player last said it is, in the session's seconds. */
  playerTime = 0;
  /** The blocked reloads waiting for a segment. */
  readonly waiters = new Set<() => void>();
  /** The kinds whose first playlist the player has read (`HEAD_START`). */
  readonly read = new Set<Kind>();
  /** Whether any audio is listed yet: before it, the audio may start late,
   *  as it does after a seek, where a page appends the ten seconds of audio
   *  that hold where it went, after the video's key frame before it. */
  audioStarted = false;
  gone = false;

  constructor(
    readonly number: number,
    origin: number,
    decodeOrigin: number,
    start: number,
  ) {
    this.origin = origin;
    this.decodeOrigin = decodeOrigin;
    this.videoNext = decodeOrigin;
    this.audioNext = origin;
    this.startAt = Math.max(0, start - origin);
  }

  listed(): number {
    const last = this.segments[this.segments.length - 1];
    return last ? last.start + last.duration : 0;
  }

  wake(): void {
    for (const w of [...this.waiters]) w();
  }
}

/** What a feed needs of the host. */
export interface FeedSeams {
  /** What the element's player is to play, or null for nothing any more,
   *  and where in it, in seconds, it is to start. */
  show(element: Element, url: string | null, at?: number): void;
  /** Where the loopback server answers, once it does, and the token's
   *  requests to `request`. */
  serve(
    token: string,
    request: (
      path: string,
      query: Map<string, string>,
      gone: Promise<void>,
    ) => FeedReply | Promise<FeedReply>,
  ): Promise<string>;
  /** The token's requests are no longer answered. */
  unserve(token: string): void;
}

const randomToken = (): string => {
  const bytes = new Uint8Array(16);
  (
    globalThis as unknown as {
      crypto: { getRandomValues(a: Uint8Array): Uint8Array };
    }
  ).crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * One media element's `MediaSource`: its `SourceBuffer`s, and the player's
 * playlist made of what they hold.
 */
export class Feed {
  readonly stores = new Set<SourceStore>();
  readonly token = randomToken();
  private _configs: Config[] = [];
  private _session: Session | null = null;
  private _sessions = 0;
  /** Where the next session is to start, while one is owed. */
  private _want: number | null = 0;
  private _ended = false;
  private _origin: Promise<string> | null = null;
  private _failures: number[] = [];
  disposed = false;

  constructor(
    readonly element: Element,
    /** The URL the page set, which the player's news is told by. */
    readonly pageSrc: string,
    private readonly _seams: FeedSeams,
    /** Where the element's clock is as the source opens. */
    time: number,
  ) {
    this._want = time;
  }

  /** The config a track's frames are appended under: one the feed had, if
   *  its sample entry is the same, so that a quality the page goes back to
   *  is the `EXT-X-MAP` it had. */
  config(track: Fmp4Track): Config {
    for (const c of this._configs) {
      const t = c.track;
      if (
        t.kind === track.kind &&
        t.timescale === track.timescale &&
        t.width === track.width &&
        t.height === track.height &&
        t.entry.length === track.entry.length &&
        t.entry.every((b, i) => b === track.entry[i])
      ) {
        return c;
      }
    }
    const config = { id: this._configs.length, track };
    this._configs.push(config);
    return config;
  }

  private _track(kind: Kind): TrackBuffer | null {
    for (const store of this.stores) {
      const t = store.tracks.get(kind);
      if (t) return t;
    }
    return null;
  }

  /** Every buffer has had its first init segment, so the tracks there will
   *  be are known. */
  private _ready(): boolean {
    if (!this.stores.size) return false;
    for (const store of this.stores) if (!store.initialized) return false;
    return true;
  }

  /** What the page appended or removed: a session started where one is
   *  owed, and what follows on listed. */
  changed(): void {
    if (this.disposed || !this._ready()) return;
    if (this._want !== null) this._start(this._want);
    const s = this._session;
    if (!s || s.ended) return;
    let more = false;
    while (this._publish(s)) more = true;
    if (this._ended && !s.ended && this._drained(s)) {
      s.ended = true;
      more = true;
    }
    if (more) s.wake();
    this._show(s);
  }

  /** MSE's end of stream: what is left listed, and the playlist ended. */
  end(): void {
    this._ended = true;
    this.changed();
  }

  /** An append after the end opens the stream again, which a playlist that
   *  says it has ended cannot follow: a session from where the player is. */
  reopen(): void {
    if (!this._ended) return;
    this._ended = false;
    const s = this._session;
    if (s?.ended) this._restart(s.origin + s.playerTime);
  }

  /** Whether everything the page appended after the session's last
   *  segment is in it. */
  private _drained(s: Session): boolean {
    const video = this._track('video');
    if (video && atDecode(video.frames, s.videoNext) < video.frames.length) {
      return false;
    }
    const audio = this._track('audio');
    if (!video && audio) {
      const at = audio.frames.findIndex((f) => f.pts >= s.audioNext - 0.0005);
      if (at >= 0) return false;
    }
    return true;
  }

  /** A session from the key frame before `time`, once what follows it to
   *  `time` is there. */
  private _start(time: number): void {
    const video = this._track('video');
    const audio = this._track('audio');
    let origin: number;
    let decodeOrigin: number;
    if (video) {
      const frames = video.frames;
      // the frame showing at `time`, or one just after it, where what is
      // buffered starts a moment late
      let at = -1;
      for (let i = 0; i < frames.length; i += 1) {
        const f = frames[i];
        if (f.pts <= time + 0.0005 && time < f.pts + f.duration) {
          at = i;
          break;
        }
        if (
          f.pts > time &&
          f.pts <= time + START_SLACK &&
          (at < 0 || f.pts < frames[at].pts)
        ) {
          at = i;
        }
      }
      if (at < 0) return;
      let key = at;
      while (key > 0 && !frames[key].sync) {
        if (!following(frames[key - 1], frames[key])) return;
        key -= 1;
      }
      if (!frames[key].sync) return;
      origin = frames[key].pts;
      decodeOrigin = frames[key].dts;
    } else if (audio) {
      const f =
        audio.frames.find(
          (g) => g.pts <= time + 0.0005 && time < g.pts + g.duration,
        ) ??
        audio.frames.find((g) => g.pts > time && g.pts <= time + START_SLACK);
      if (!f) return;
      origin = f.pts;
      decodeOrigin = f.pts;
    } else {
      return;
    }
    this._want = null;
    this._sessions += 1;
    this._session = new Session(this._sessions, origin, decodeOrigin, time);
  }

  /** The next segment of the session listed, where what it needs is there. */
  private _publish(s: Session): boolean {
    const video = this._track('video');
    const audio = this._track('audio');
    let start: number;
    let end: number;
    let videoPart: SegmentTrack | undefined;
    let next: number;
    if (video) {
      const frames = video.frames;
      const first = atDecode(frames, s.videoNext);
      const head = frames[first];
      if (!head || Math.abs(head.dts - s.videoNext) > head.duration / 2) {
        return false;
      }
      let cut = -1;
      let i = first + 1;
      for (; i < frames.length; i += 1) {
        const f = frames[i];
        if (!following(frames[i - 1], f)) break;
        const span = f.dts - head.dts;
        if (
          f.config !== head.config ||
          span >= TARGET - 0.0005 ||
          (f.sync && span >= AT_KEY)
        ) {
          cut = i;
          break;
        }
      }
      if (cut < 0) {
        // what is there is all there will be only once the page has ended
        if (!this._ended || i < frames.length) return false;
        cut = i;
      }
      const taken = frames.slice(first, cut);
      const last = taken[taken.length - 1];
      next = cut < frames.length ? frames[cut].dts : last.dts + last.duration;
      start = head.dts - s.decodeOrigin;
      end = next - s.decodeOrigin;
      videoPart = { config: head.config, frames: taken, next };
    } else if (audio) {
      const frames = audio.frames;
      const first = frames.findIndex((f) => f.pts >= s.audioNext - 0.0005);
      if (first < 0) return false;
      const head = frames[first];
      if (Math.abs(head.pts - s.audioNext) > head.duration / 2) return false;
      let cut = -1;
      let i = first + 1;
      for (; i < frames.length; i += 1) {
        if (!following(frames[i - 1], frames[i])) break;
        if (
          frames[i].config !== head.config ||
          frames[i].pts - head.pts >= TARGET - 0.0005
        ) {
          cut = i;
          break;
        }
      }
      if (cut < 0) {
        if (!this._ended || i < frames.length) return false;
        cut = i;
      }
      const taken = frames.slice(first, cut);
      const last = taken[taken.length - 1];
      next = cut < frames.length ? frames[cut].pts : last.pts + last.duration;
      start = head.pts - s.origin;
      end = next - s.origin;
      const part = { config: head.config, frames: taken, next };
      s.audioNext = next;
      this._list(s, start, end, undefined, part);
      return true;
    } else {
      return false;
    }
    let audioPart: SegmentTrack | undefined;
    if (audio) {
      // what shows in the same span of the session
      const until = end + s.origin;
      const frames = audio.frames;
      let first = frames.findIndex((f) => f.pts >= s.audioNext - 0.0005);
      const taken: Frame[] = [];
      if (first >= 0) {
        for (
          let i = first;
          i < frames.length && frames[i].pts < until - 0.0005;
          i += 1
        ) {
          if (taken.length && !following(taken[taken.length - 1], frames[i])) {
            break;
          }
          taken.push(frames[i]);
        }
      } else {
        first = frames.length;
      }
      const last = taken[taken.length - 1];
      const reached = last ? last.pts + last.duration : s.audioNext;
      const slack = last ? last.duration / 2 : 0.05;
      // audio from where the last span's ended to this one's end, or all
      // the page will append of it; but the first may start late, and a
      // span before the audio starts is a gap (`#EXT-X-GAP`)
      const late = !s.audioStarted && first < frames.length;
      const before =
        late && !taken.length && frames[first].pts >= until - 0.0005;
      const joined =
        !taken.length ||
        late ||
        Math.abs(taken[0].pts - s.audioNext) <= Math.max(slack * 2, 0.05);
      if (!before && (!joined || reached < until - slack) && !this._ended) {
        return false;
      }
      if (taken.length) {
        const after = frames[first + taken.length];
        audioPart = {
          config: taken[0].config,
          frames: taken,
          next: after && following(last, after) ? after.pts : reached,
        };
        s.audioNext = audioPart.next;
        s.audioStarted = true;
      }
    }
    s.videoNext = next;
    this._list(s, start, end, videoPart, audioPart);
    return true;
  }

  private _list(
    s: Session,
    start: number,
    end: number,
    video: SegmentTrack | undefined,
    audio: SegmentTrack | undefined,
  ): void {
    let bytes = 0;
    for (const part of [video, audio]) {
      for (const f of part?.frames ?? []) bytes += f.data.length;
    }
    s.segments.push({ start, duration: end - start, video, audio, bytes });
  }

  /** The player is handed the session once enough of it is listed. */
  private _show(s: Session): void {
    if (s.shown || s.gone) return;
    if (s.listed() < s.startAt + BEFORE_PLAYER && !s.ended) return;
    if (!s.segments.length) return;
    s.shown = true;
    this._origin ??= this._seams.serve(this.token, (path, query, gone) =>
      this.request(path, query, gone),
    );
    void this._origin.then((origin) => {
      if (this._session !== s || this.disposed) return;
      this._seams.show(
        this.element,
        `${origin}/${this.token}/${s.number}/master.m3u8`,
        s.startAt,
      );
    });
  }

  /** A session that starts again at `time`: the player goes at once, and a
   *  new one is handed the new session once enough of it is there. */
  private _restart(time: number): void {
    const s = this._session;
    if (s) {
      s.gone = true;
      s.wake();
      if (s.shown) this._seams.show(this.element, null);
    }
    this._session = null;
    this._want = time;
    this.changed();
  }

  /**
   * The page sought to `time`: where the player has it, far enough from the
   * end of a playlist that is still growing for it to go there, the time to
   * seek the player to, in the session's seconds; otherwise a session of its
   * own, and null.
   */
  seek(time: number): number | null {
    const s = this._session;
    if (s?.shown && !s.gone) {
      const t = time - s.origin;
      const listed = s.listed();
      const reach = s.ended ? listed : listed - 3 * TARGET - 1;
      const seg = s.segments.find(
        (g) => t >= g.start && t < g.start + g.duration,
      );
      const kept = seg && (seg.video ?? seg.audio)?.frames;
      if (t >= 0 && t <= reach && kept) return t;
    }
    this._restart(time);
    return null;
  }

  /**
   * What the player said, as the page is to hear it: its time in the page's
   * seconds, its end only where the page's stream ended, and its failure only
   * once sessions of their own have failed it too — a session it failed is
   * started again where it was. Null where the page hears nothing of it: a
   * player of a session gone, and its length, which is the page's to say.
   */
  playerSaid(
    url: string,
    kind: string,
    value: string,
  ): { kind: string; value: string } | null {
    const s = this._session;
    if (!s || !url.includes(`/${this.token}/${s.number}/`)) return null;
    if (kind === 'time') {
      const t = Number(value);
      if (!Number.isFinite(t)) return null;
      s.playerTime = t;
      this._trim(s);
      return { kind, value: String(s.origin + t) };
    }
    if (kind === 'ended') return s.ended ? { kind, value } : null;
    if (kind === 'error') {
      const now = Date.now();
      this._failures = this._failures.filter((t) => now - t < 60_000);
      this._failures.push(now);
      if (this._failures.length >= MOST_FAILURES) return { kind, value };
      this._restart(s.origin + s.playerTime);
      return null;
    }
    return null;
  }

  /** The frames of segments the player is far past go. */
  private _trim(s: Session): void {
    const before = s.playerTime - KEEP_BEHIND;
    for (const seg of s.segments) {
      if (seg.start + seg.duration >= before) break;
      if (seg.video) seg.video.frames = null;
      if (seg.audio) seg.audio.frames = null;
    }
  }

  /** A request of the loopback server's, by the path under the token. */
  request(
    path: string,
    query: Map<string, string>,
    gone: Promise<void>,
  ): FeedReply | Promise<FeedReply> {
    const slash = path.indexOf('/');
    const s = this._session;
    if (slash < 0 || !s || String(s.number) !== path.slice(0, slash)) {
      return { status: 404 };
    }
    const name = path.slice(slash + 1);
    if (name === 'master.m3u8') {
      return { status: 200, type: PLAYLIST, body: encode(this._master(s)) };
    }
    let m = /^([va])\.m3u8$/.exec(name);
    if (m) {
      const kind: Kind = m[1] === 'v' ? 'video' : 'audio';
      const msn = query.get('_HLS_msn');
      if (msn === undefined || s.ended) {
        const first = !s.read.has(kind);
        s.read.add(kind);
        return {
          status: 200,
          type: PLAYLIST,
          body: encode(this._media(s, kind, first)),
        };
      }
      const want = Number(msn);
      if (!(want >= 0) || want > s.segments.length + 1) return { status: 400 };
      return this._blocked(s, kind, want, gone);
    }
    m = /^([va])i(\d+)\.mp4$/.exec(name);
    if (m) {
      const config = this._configs[Number(m[2])];
      if (!config) return { status: 404 };
      return {
        status: 200,
        type: m[1] === 'v' ? 'video/mp4' : 'audio/mp4',
        body: [initSegment(config.track)],
      };
    }
    m = /^([va])(\d+)\.m4s$/.exec(name);
    if (m) {
      const seg = s.segments[Number(m[2])];
      const part = seg && (m[1] === 'v' ? seg.video : seg.audio);
      if (!part?.frames) return { status: seg ? 410 : 404 };
      return {
        status: 200,
        type: m[1] === 'v' ? 'video/mp4' : 'audio/mp4',
        body: this._segment(s, Number(m[2]), part, m[1] === 'v'),
      };
    }
    return { status: 404 };
  }

  /** A blocking playlist reload (RFC 8216bis, 6.2.5.2): held until the
   *  segment it asks for is listed, the playlist ends, or the session or
   *  the request goes — never answered with what it had, which AVFoundation
   *  takes for a failure. */
  private _blocked(
    s: Session,
    kind: Kind,
    want: number,
    gone: Promise<void>,
  ): Promise<FeedReply> {
    return new Promise((resolve) => {
      let done = false;
      const check = (): void => {
        if (done) return;
        if (s.gone || this.disposed) {
          done = true;
          s.waiters.delete(check);
          resolve({ status: 404 });
          return;
        }
        if (s.segments.length > want || s.ended) {
          done = true;
          s.waiters.delete(check);
          resolve({
            status: 200,
            type: PLAYLIST,
            body: encode(this._media(s, kind)),
          });
        }
      };
      s.waiters.add(check);
      void gone.then(() => {
        done = true;
        s.waiters.delete(check);
        resolve({ status: 499 });
      });
      check();
    });
  }

  private _master(s: Session): string {
    const video = s.segments.find((g) => g.video)?.video?.config.track;
    const audio = s.segments.find((g) => g.audio)?.audio?.config.track;
    let bytes = 0;
    let seconds = 0;
    for (const g of s.segments) {
      bytes += g.bytes;
      seconds += g.duration;
    }
    const bandwidth = Math.max(
      64_000,
      Math.round(seconds > 0 ? (bytes * 8) / seconds : 5_000_000),
    );
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
    const codecs = [video?.codec, audio?.codec].filter(Boolean).join(',');
    if (video && audio) {
      lines.push(
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="a.m3u8"',
      );
    }
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codecs}"` +
        (video ? `,RESOLUTION=${video.width}x${video.height}` : '') +
        (video && audio ? ',AUDIO="a"' : ''),
      video ? 'v.m3u8' : 'a.m3u8',
      '',
    );
    return lines.join('\n');
  }

  /** A media playlist. The first the player reads of a kind lists no more
   *  than `HEAD_START` segments from the one it starts in, unless the
   *  stream has ended, when it starts where it is told. */
  private _media(s: Session, kind: Kind, first = false): string {
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${TARGET}`,
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES',
      '#EXT-X-MEDIA-SEQUENCE:0',
    ];
    const letter = kind === 'video' ? 'v' : 'a';
    let map = -1;
    let count = s.segments.length;
    if (first && !s.ended) {
      const at = s.segments.findIndex((g) => s.startAt < g.start + g.duration);
      count = Math.min(count, (at < 0 ? 0 : at) + HEAD_START);
    }
    s.segments.slice(0, count).forEach((seg, i) => {
      const part = kind === 'video' ? seg.video : seg.audio;
      if (!part) {
        // nothing of this kind in this span: a gap the player passes over
        lines.push('#EXT-X-GAP');
      } else if (part.config.id !== map) {
        map = part.config.id;
        lines.push(`#EXT-X-MAP:URI="${letter}i${map}.mp4"`);
      }
      lines.push(`#EXTINF:${seg.duration.toFixed(6)},`, `${letter}${i}.m4s`);
    });
    if (s.ended && count === s.segments.length) lines.push('#EXT-X-ENDLIST');
    lines.push('');
    return lines.join('\n');
  }

  /** A segment's bytes: its frames' timestamps from the session's start, in
   *  its config's ticks, its first presentation at its first decode. */
  private _segment(
    s: Session,
    index: number,
    part: SegmentTrack,
    video: boolean,
  ): Uint8Array[] {
    const frames = part.frames!;
    const scale = part.config.track.timescale;
    const decodeFrom = video ? s.decodeOrigin : s.origin;
    const tick = (seconds: number): number => Math.round(seconds * scale);
    const decode = frames.map((f) =>
      tick((video ? f.dts : f.pts) - decodeFrom),
    );
    const end = tick(part.next - decodeFrom);
    const samples: SegmentSample[] = frames.map((f, i) => ({
      duration: Math.max(
        1,
        (i + 1 < frames.length ? decode[i + 1] : end) - decode[i],
      ),
      cto: video ? tick(f.pts - s.origin) - decode[i] : 0,
      sync: f.sync,
      data: f.data,
    }));
    return mediaSegment(index + 1, Math.max(0, decode[0]), samples);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const s = this._session;
    if (s) {
      s.gone = true;
      s.wake();
      if (s.shown) this._seams.show(this.element, null);
    }
    if (this._origin) this._seams.unserve(this.token);
  }
}

/**
 * The page's `SourceBuffer`s of fragmented MP4, by the ids the page's realm
 * knows them by, and the feeds of the elements they are attached to.
 */
export class Feeds {
  private readonly _stores = new Map<number, SourceStore>();
  private readonly _feeds = new Map<Element, Feed>();

  constructor(private readonly _seams: FeedSeams) {}

  /** A `SourceBuffer` for the element whose source the page set as
   *  `pageSrc`, by the id it is to be known by; `time` is where its clock
   *  is. */
  open(id: number, element: Element, pageSrc: string, time: number): void {
    let feed = this._feeds.get(element);
    if (!feed || feed.disposed || feed.pageSrc !== pageSrc) {
      feed?.dispose();
      feed = new Feed(element, pageSrc, this._seams, time);
      this._feeds.set(element, feed);
    }
    const store = new SourceStore(feed);
    feed.stores.add(store);
    this._stores.set(id, store);
  }

  has(id: number): boolean {
    return this._stores.has(id);
  }

  append(id: number, bytes: Uint8Array, params: AppendParams): FeedAnswer {
    const store = this._stores.get(id);
    if (!store) return { failed: true, ranges: [] };
    store.feed.reopen();
    const out = store.append(bytes, params);
    store.feed.changed();
    return out;
  }

  remove(id: number, start: number, end: number): FeedAnswer {
    const store = this._stores.get(id);
    if (!store) return { ranges: [] };
    const out = store.remove(start, end);
    store.feed.changed();
    return out;
  }

  /** `abort()`, and `changeType()` to a type a feed takes. */
  reset(id: number): void {
    this._stores.get(id)?.reset();
  }

  end(id: number): void {
    this._stores.get(id)?.feed.end();
  }

  close(id: number): void {
    const store = this._stores.get(id);
    if (!store) return;
    this._stores.delete(id);
    store.feed.stores.delete(store);
    if (!store.feed.stores.size) {
      store.feed.dispose();
      if (this._feeds.get(store.feed.element) === store.feed) {
        this._feeds.delete(store.feed.element);
      }
    } else {
      store.feed.changed();
    }
  }

  /** The element's feed, where it has one. */
  of(element: Element): Feed | undefined {
    const feed = this._feeds.get(element);
    return feed && !feed.disposed ? feed : undefined;
  }

  dispose(): void {
    for (const feed of this._feeds.values()) feed.dispose();
    this._feeds.clear();
    this._stores.clear();
  }
}
