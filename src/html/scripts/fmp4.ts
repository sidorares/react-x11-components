// Fragmented MP4 as a page appends it to a `SourceBuffer` (MSE's ISO BMFF
// byte stream format), and as the platform's player is handed it again,
// a segment at a time over a playlist (`feeds.ts`).
//
// **It is read as it arrives.** YouTube appends a segment in pieces of ten
// kilobytes or so: a `moof` and the head of its `mdat` in one, and the
// samples in the pieces after, and Chrome's `buffered` grows a frame at a
// time as they come. So `Fmp4Reader.push` hands back each sample as its
// last byte arrives, and keeps what it has of the next.
//
// **Nothing is decoded.** A sample is the bytes the page appended, and only
// the boxes around them are read or written: a track's sample entry —
// `avc1` with its `avcC`, `mp4a` with its `esds` — is handed to the player
// as it was written, and the player decodes what it names.

import { ascii, box, fullBox, MATRIX, u16, u32, zeros } from './mp4.js';

export type TrackKind = 'video' | 'audio' | 'other';

/** `trex`'s defaults, for a fragment that says nothing of its own. */
interface Defaults {
  duration: number;
  size: number;
  flags: number;
}

/** A track, as an initialization segment describes it. */
export interface Fmp4Track {
  /** Its `track_ID` in the page's stream. */
  id: number;
  kind: TrackKind;
  /** Ticks a second. */
  timescale: number;
  /** Its first sample entry, box and all, as written. */
  entry: Uint8Array;
  /** The sample entry's four letters: `avc1`, `mp4a`, `encv`. */
  format: string;
  /** RFC 6381's name for what it holds — `avc1.4d401f`, `mp4a.40.2` — or
   *  its format alone, where nothing here names it further. */
  codec: string;
  width: number;
  height: number;
  /** What its edit list starts it at, in ticks, which every time is taken
   *  back by: Chrome's MSE reads the first edit so, and YouTube's video
   *  starts its first frame a frame in for its B-frames. */
  shift: number;
  defaults: Defaults;
}

/** An initialization segment (MSE's ISO BMFF byte stream format, 3). */
export interface Fmp4Init {
  tracks: Fmp4Track[];
  /** How long the stream says it is, in seconds, where it says. */
  duration: number | null;
}

/** A coded frame, in ticks of its track's timescale. */
export interface Fmp4Sample {
  /** Its track's `track_ID`. */
  track: number;
  dts: number;
  pts: number;
  duration: number;
  /** A random access point: a frame nothing before it is needed for. */
  sync: boolean;
  /** Its bytes, a copy the reader keeps no hold on. */
  data: Uint8Array;
}

/** What a push came to, in the order the stream has it: a new
 *  initialization segment applies to the samples after it. */
export type Fmp4Item = { init: Fmp4Init } | { sample: Fmp4Sample };

/** The largest `moov` or `moof` read whole: one past this is no stream's. */
const MOST_BOX = 64 << 20;
/** `sample_is_non_sync_sample`, in a sample's flags. */
const NON_SYNC = 0x10000;

/** A sample read from its `moof`, whose bytes are still to come. */
interface Due {
  track: Fmp4Track;
  /** Where its bytes start in the stream. */
  at: number;
  size: number;
  dts: number;
  pts: number;
  duration: number;
  sync: boolean;
}

const u32At = (b: Uint8Array, at: number): number =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const s32At = (b: Uint8Array, at: number): number => u32At(b, at) | 0;
const u64At = (b: Uint8Array, at: number): number =>
  u32At(b, at) * 2 ** 32 + u32At(b, at + 4);
const u16At = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1];
const typeAt = (b: Uint8Array, at: number): string =>
  String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** A box's children, as `[type, body start, end]`, or null where one runs
 *  past its parent. */
function children(
  b: Uint8Array,
  from: number,
  to: number,
): [string, number, number][] | null {
  const out: [string, number, number][] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32At(b, at);
    let head = 8;
    if (size === 1) {
      if (at + 16 > to) return null;
      size = u64At(b, at + 8);
      head = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < head || at + size > to) return null;
    out.push([typeAt(b, at + 4), at + head, at + size]);
    at += size;
  }
  return out;
}

const child = (
  boxes: [string, number, number][] | null,
  type: string,
): [string, number, number] | undefined => boxes?.find(([t]) => t === type);

const hex = (n: number): string => n.toString(16).padStart(2, '0');

/** RFC 6381's name for an AAC stream's object type, from its `esds`
 *  (ISO/IEC 14496-1, 7.2.6): `mp4a.40.2` for AAC LC. */
function mp4aCodec(b: Uint8Array, from: number, to: number): string {
  let at = from + 4;
  let oti = 0;
  while (at < to) {
    const tag = b[at];
    at += 1;
    let length = 0;
    for (let i = 0; i < 4 && at < to; i += 1) {
      const byte = b[at];
      at += 1;
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    if (tag === 3) {
      const flags = b[at + 2];
      at += 3;
      if (flags & 0x80) at += 2;
      if (flags & 0x40) at += 1 + b[at];
      if (flags & 0x20) at += 2;
    } else if (tag === 4) {
      oti = b[at];
      at += 13;
    } else if (tag === 5) {
      if (oti !== 0x40) break;
      let aot = b[at] >> 3;
      if (aot === 31) aot = 32 + (((b[at] & 7) << 3) | (b[at + 1] >> 5));
      return `mp4a.40.${aot}`;
    } else {
      at += length;
    }
  }
  return oti ? `mp4a.${hex(oti)}` : 'mp4a';
}

/** A track's sample entry, read for its name and its size. */
function readEntry(
  b: Uint8Array,
  from: number,
  to: number,
): {
  format: string;
  codec: string;
  width: number;
  height: number;
} {
  const format = typeAt(b, from + 4);
  const body = from + 8;
  if (format === 'avc1' || format === 'avc3') {
    const inner = children(b, body + 78, to);
    const avcC = child(inner, 'avcC');
    const codec = avcC
      ? `${format}.${hex(b[avcC[1] + 1])}${hex(b[avcC[1] + 2])}${hex(b[avcC[1] + 3])}`
      : format;
    return {
      format,
      codec,
      width: u16At(b, body + 24),
      height: u16At(b, body + 26),
    };
  }
  if (format === 'mp4a') {
    const inner = children(b, body + 28, to);
    const esds = child(inner, 'esds');
    return {
      format,
      codec: esds ? mp4aCodec(b, esds[1], esds[2]) : format,
      width: 0,
      height: 0,
    };
  }
  return { format, codec: format, width: 0, height: 0 };
}

/** An initialization segment's `moov`, or null where it is not one. */
export function readInit(b: Uint8Array): Fmp4Init | null {
  const top = children(b, 8, b.length);
  if (!top) return null;
  const mvhd = child(top, 'mvhd');
  const movieScale = mvhd
    ? b[mvhd[1]]
      ? u32At(b, mvhd[1] + 20)
      : u32At(b, mvhd[1] + 12)
    : 0;
  const defaults = new Map<number, Defaults>();
  let duration: number | null = null;
  const mvex = child(top, 'mvex');
  if (mvex) {
    for (const [type, from] of children(b, mvex[1], mvex[2]) ?? []) {
      if (type === 'trex') {
        defaults.set(u32At(b, from + 4), {
          duration: u32At(b, from + 12),
          size: u32At(b, from + 16),
          flags: u32At(b, from + 20),
        });
      } else if (type === 'mehd' && movieScale) {
        const ticks = b[from] ? u64At(b, from + 4) : u32At(b, from + 4);
        if (ticks) duration = ticks / movieScale;
      }
    }
  }
  if (duration === null && mvhd && movieScale) {
    const ticks = b[mvhd[1]] ? u64At(b, mvhd[1] + 24) : u32At(b, mvhd[1] + 16);
    // all ones is "not known", and 0 is a fragmented file's
    if (ticks && ticks !== 0xffffffff) duration = ticks / movieScale;
  }
  const tracks: Fmp4Track[] = [];
  for (const [type, from, to] of top) {
    if (type !== 'trak') continue;
    const trak = children(b, from, to);
    const tkhd = child(trak, 'tkhd');
    const mdia = child(trak, 'mdia');
    if (!tkhd || !mdia) return null;
    const v1 = b[tkhd[1]] === 1;
    const id = u32At(b, tkhd[1] + (v1 ? 20 : 12));
    const boxes = children(b, mdia[1], mdia[2]);
    const mdhd = child(boxes, 'mdhd');
    const hdlr = child(boxes, 'hdlr');
    const minf = child(boxes, 'minf');
    if (!mdhd || !hdlr || !minf) return null;
    const timescale = b[mdhd[1]]
      ? u32At(b, mdhd[1] + 20)
      : u32At(b, mdhd[1] + 12);
    const handler = typeAt(b, hdlr[1] + 8);
    const stbl = child(children(b, minf[1], minf[2]), 'stbl');
    const stsd = stbl && child(children(b, stbl[1], stbl[2]), 'stsd');
    const first = stsd && children(b, stsd[1] + 8, stsd[2])?.[0];
    if (!first || !timescale) return null;
    // the entry's head is before where `children` says its body starts
    const entryFrom = first[1] - 8;
    const entry = b.slice(entryFrom, first[2]);
    const read = readEntry(b, entryFrom, first[2]);
    const tkhdWidth = u32At(b, tkhd[1] + (v1 ? 88 : 76)) / 0x10000;
    const tkhdHeight = u32At(b, tkhd[1] + (v1 ? 92 : 80)) / 0x10000;
    let shift = 0;
    const edts = child(trak, 'edts');
    const elst = edts && child(children(b, edts[1], edts[2]), 'elst');
    if (elst) {
      const version = b[elst[1]];
      const count = u32At(b, elst[1] + 4);
      let at = elst[1] + 8;
      for (let i = 0; i < count; i += 1) {
        const time =
          version === 1
            ? Number(new DataView(b.buffer, b.byteOffset).getBigInt64(at + 8))
            : s32At(b, at + 4);
        at += version === 1 ? 20 : 12;
        // an empty edit, which delays the track, Chrome passes over
        if (time >= 0) {
          shift = time;
          break;
        }
      }
    }
    tracks.push({
      id,
      kind:
        handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other',
      timescale,
      entry,
      format: read.format,
      codec: read.codec,
      width: Math.round(tkhdWidth) || read.width,
      height: Math.round(tkhdHeight) || read.height,
      shift,
      defaults: defaults.get(id) ?? { duration: 0, size: 0, flags: 0 },
    });
  }
  return tracks.length ? { tracks, duration } : null;
}

export class Fmp4Reader {
  /** The last initialization segment read. */
  init: Fmp4Init | null = null;
  /** Why what arrived cannot be read any further, once it cannot. */
  failed: string | null = null;

  private _bytes = new Uint8Array(1 << 16);
  private _from = 0;
  private _to = 0;
  /** What has been let go of `_bytes`, so that a place in the stream is
   *  `_gone + _from`. */
  private _gone = 0;
  /** What of a box nobody reads has still to come. */
  private _skipping = 0;
  /** Where the `mdat` being read ends, while one is. */
  private _mdatEnd = -1;
  /** The samples its `moof` said it holds, in the order they are in it. */
  private _due: Due[] = [];
  private _next = 0;
  /** Where each track's next fragment starts, for one with no `tfdt`. */
  private _decodeNext = new Map<number, number>();

  /** The chunk, and the initialization segments and samples it completed. */
  push(chunk: Uint8Array): Fmp4Item[] {
    const out: Fmp4Item[] = [];
    if (this.failed) return out;
    this._keep(chunk);
    while (!this.failed && this._step(out));
    return out;
  }

  /** MSE 3.5's "reset parser state", as `abort()` runs it: what is half
   *  read goes, and the next byte starts a segment. */
  reset(): void {
    this._from = 0;
    this._to = 0;
    this._gone = 0;
    this._skipping = 0;
    this._mdatEnd = -1;
    this._due = [];
    this._next = 0;
    this._decodeNext.clear();
  }

  private _pos(): number {
    return this._gone + this._from;
  }

  private _fail(why: string): false {
    this.failed = why;
    return false;
  }

  private _keep(chunk: Uint8Array): void {
    const held = this._to - this._from;
    if (this._to + chunk.length > this._bytes.length) {
      const need = held + chunk.length;
      if (need > this._bytes.length) {
        const into = new Uint8Array(Math.max(need, this._bytes.length * 2));
        into.set(this._bytes.subarray(this._from, this._to));
        this._bytes = into;
      } else {
        this._bytes.copyWithin(0, this._from, this._to);
      }
      this._gone += this._from;
      this._from = 0;
      this._to = held;
    }
    this._bytes.set(chunk, this._to);
    this._to += chunk.length;
  }

  private _step(out: Fmp4Item[]): boolean {
    const held = this._to - this._from;
    if (this._skipping > 0) {
      const n = Math.min(this._skipping, held);
      this._from += n;
      this._skipping -= n;
      return this._skipping === 0 && n > 0;
    }
    if (this._mdatEnd >= 0) return this._mdat(out);
    if (held < 8) return false;
    const b = this._bytes;
    const at = this._from;
    let size = u32At(b, at);
    const type = typeAt(b, at + 4);
    let head = 8;
    if (size === 1) {
      if (held < 16) return false;
      size = u64At(b, at + 8);
      head = 16;
    } else if (size === 0) {
      // to the end of the stream, which only a `mdat` may be
      if (type !== 'mdat') return this._fail(`a ${type} with no size`);
      size = Infinity;
    }
    if (size < head) return this._fail(`a ${type} shorter than its head`);
    if (type === 'mdat') {
      if (!this.init) {
        return this._fail('media data before an initialization segment');
      }
      this._from += head;
      this._mdatEnd = this._pos() + (size - head);
      return true;
    }
    if (type === 'moov' || type === 'moof') {
      if (size > MOST_BOX) return this._fail(`a ${type} of ${size} bytes`);
      if (held < size) return false;
      const start = this._pos();
      const whole = b.subarray(at, at + size);
      this._from += size;
      if (type === 'moov') {
        const init = readInit(whole);
        if (!init)
          return this._fail('an initialization segment it cannot read');
        this.init = init;
        this._decodeNext.clear();
        out.push({ init });
        return true;
      }
      if (!this.init) {
        return this._fail('a media segment before an initialization segment');
      }
      if (this._next < this._due.length) {
        return this._fail('a media segment before the data of the last');
      }
      return this._fragment(whole, start);
    }
    // what nobody reads: `ftyp`, `styp`, `sidx`, `emsg`, `free`, `prft`
    const n = Math.min(size, held);
    this._from += n;
    this._skipping = size - n;
    return true;
  }

  /** A `moof`'s samples, each where its bytes will be (ISO/IEC 14496-12,
   *  8.8.7 to 8.8.12). */
  private _fragment(b: Uint8Array, start: number): boolean {
    const due: Due[] = [];
    let dataEnd = start;
    let first = true;
    for (const [type, from, to] of children(b, 8, b.length) ?? []) {
      if (type !== 'traf') continue;
      const traf = children(b, from, to);
      const tfhd = child(traf, 'tfhd');
      if (!tfhd) return this._fail('a track fragment with no header');
      const flags = u32At(b, tfhd[1]) & 0xffffff;
      const track = this.init!.tracks.find(
        (t) => t.id === u32At(b, tfhd[1] + 4),
      );
      if (!track) return this._fail('a fragment of a track it was not told of');
      let at = tfhd[1] + 8;
      // an offset in a file, which a byte stream has none of
      if (flags & 0x1) return this._fail('a base data offset');
      if (flags & 0x2) at += 4;
      let duration = track.defaults.duration;
      let size = track.defaults.size;
      let sampleFlags = track.defaults.flags;
      if (flags & 0x8) {
        duration = u32At(b, at);
        at += 4;
      }
      if (flags & 0x10) {
        size = u32At(b, at);
        at += 4;
      }
      if (flags & 0x20) sampleFlags = u32At(b, at);
      const base = flags & 0x20000 || first ? start : dataEnd;
      first = false;
      const tfdt = child(traf, 'tfdt');
      let dts = tfdt
        ? b[tfdt[1]]
          ? u64At(b, tfdt[1] + 4)
          : u32At(b, tfdt[1] + 4)
        : (this._decodeNext.get(track.id) ?? 0);
      let data = base;
      for (const [kind, rf] of traf ?? []) {
        if (kind !== 'trun') continue;
        const version = b[rf];
        const run = u32At(b, rf) & 0xffffff;
        const count = u32At(b, rf + 4);
        let p = rf + 8;
        if (run & 0x1) {
          data = base + s32At(b, p);
          p += 4;
        }
        let firstFlags = -1;
        if (run & 0x4) {
          firstFlags = u32At(b, p);
          p += 4;
        }
        for (let i = 0; i < count; i += 1) {
          let d = duration;
          let s = size;
          let f = i === 0 && firstFlags >= 0 ? firstFlags : sampleFlags;
          let cto = 0;
          if (run & 0x100) {
            d = u32At(b, p);
            p += 4;
          }
          if (run & 0x200) {
            s = u32At(b, p);
            p += 4;
          }
          if (run & 0x400) {
            f = u32At(b, p);
            p += 4;
          }
          if (run & 0x800) {
            cto = version ? s32At(b, p) : u32At(b, p);
            p += 4;
          }
          due.push({
            track,
            at: data,
            size: s,
            dts: dts - track.shift,
            pts: dts + cto - track.shift,
            duration: d,
            sync: !(f & NON_SYNC),
          });
          data += s;
          dts += d;
        }
        dataEnd = Math.max(dataEnd, data);
      }
      this._decodeNext.set(track.id, dts);
    }
    due.sort((x, y) => x.at - y.at);
    this._due = due;
    this._next = 0;
    return true;
  }

  /** What of a `mdat` has arrived: each sample whose last byte has, and
   *  what lies between them passed over. */
  private _mdat(out: Fmp4Item[]): boolean {
    const held = this._to - this._from;
    const pos = this._pos();
    const end = this._mdatEnd;
    const next = this._due[this._next];
    if (!next || next.at >= end) {
      const n = Math.min(held, end - pos);
      this._from += n;
      if (this._pos() < end) return false;
      this._mdatEnd = -1;
      if (this._next < this._due.length) {
        return this._fail('a sample outside its media data');
      }
      return true;
    }
    if (next.at < pos) return this._fail('samples that overlap');
    if (next.at > pos) {
      const n = Math.min(held, next.at - pos);
      this._from += n;
      return n > 0;
    }
    if (next.at + next.size > end) {
      return this._fail('a sample past the end of its media data');
    }
    if (held < next.size) return false;
    const data = this._bytes.slice(this._from, this._from + next.size);
    this._from += next.size;
    this._next += 1;
    out.push({
      sample: {
        track: next.track.id,
        dts: next.dts,
        pts: next.pts,
        duration: next.duration,
        sync: next.sync,
        data,
      },
    });
    if (this._next >= this._due.length) {
      this._due = [];
      this._next = 0;
    }
    if (this._pos() >= end) this._mdatEnd = -1;
    return true;
  }
}

// --- what the player is handed --------------------------------------------------

/** An initialization segment of one track, as `track_ID` 1, around the
 *  page's sample entry: what each segment's `EXT-X-MAP` names. */
export function initSegment(track: Fmp4Track): Uint8Array {
  const video = track.kind === 'video';
  return concat([
    box(
      'ftyp',
      ascii('iso6'),
      u32(0),
      ascii('iso6'),
      ascii('cmfc'),
      ascii('mp41'),
    ),
    box(
      'moov',
      fullBox(
        'mvhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(track.timescale),
        u32(0),
        u32(0x00010000),
        u16(0x0100),
        zeros(10),
        MATRIX,
        zeros(24),
        u32(2),
      ),
      box(
        'trak',
        fullBox(
          'tkhd',
          0,
          3,
          u32(0),
          u32(0),
          u32(1),
          u32(0),
          u32(0),
          zeros(8),
          u16(0),
          u16(0),
          u16(video ? 0 : 0x0100),
          u16(0),
          MATRIX,
          u32(track.width * 0x10000),
          u32(track.height * 0x10000),
        ),
        box(
          'mdia',
          fullBox(
            'mdhd',
            0,
            0,
            u32(0),
            u32(0),
            u32(track.timescale),
            u32(0),
            u16(0x55c4),
            u16(0),
          ),
          fullBox(
            'hdlr',
            0,
            0,
            u32(0),
            ascii(video ? 'vide' : 'soun'),
            zeros(12),
            ascii(video ? 'VideoHandler' : 'SoundHandler'),
            [0],
          ),
          box(
            'minf',
            video
              ? fullBox('vmhd', 0, 1, zeros(8))
              : fullBox('smhd', 0, 0, zeros(4)),
            box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            box(
              'stbl',
              fullBox('stsd', 0, 0, u32(1), track.entry),
              fullBox('stts', 0, 0, u32(0)),
              fullBox('stsc', 0, 0, u32(0)),
              fullBox('stsz', 0, 0, u32(0), u32(0)),
              fullBox('stco', 0, 0, u32(0)),
            ),
          ),
        ),
      ),
      box(
        'mvex',
        fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)),
      ),
    ),
  ]);
}

/** A sample of a segment, in ticks of its init segment's timescale. */
export interface SegmentSample {
  /** How long it lasts in decode order. */
  duration: number;
  /** How far its presentation is from its decode, which may be less than
   *  nothing: a segment starts its presentation where its decode starts
   *  (CMAF's `trun` version 1). */
  cto: number;
  sync: boolean;
  data: Uint8Array;
}

/** A media segment of track 1: its `moof`, the head of its `mdat`, and the
 *  samples' bytes as they are, which a response writes one after another. */
export function mediaSegment(
  sequence: number,
  decodeTime: number,
  samples: SegmentSample[],
): Uint8Array[] {
  const entries = new Uint8Array(samples.length * 16);
  let bytes = 0;
  samples.forEach((s, i) => {
    entries.set(
      [
        ...u32(s.duration),
        ...u32(s.data.length),
        ...u32(s.sync ? 0x02000000 : 0x01010000),
        ...u32(s.cto),
      ],
      i * 16,
    );
    bytes += s.data.length;
  });
  const high = Math.floor(decodeTime / 2 ** 32);
  /** The fragment, with where its data starts from its own first byte. */
  const moof = (offset: number): Uint8Array =>
    box(
      'moof',
      fullBox('mfhd', 0, 0, u32(sequence)),
      box(
        'traf',
        fullBox('tfhd', 0, 0x20000, u32(1)),
        fullBox('tfdt', 1, 0, u32(high), u32(decodeTime - high * 2 ** 32)),
        fullBox('trun', 1, 0xf01, u32(samples.length), u32(offset), entries),
      ),
    );
  // the fragment is the same size whatever offset it names
  const head = moof(moof(0).length + 8);
  return [
    head,
    new Uint8Array([...u32(bytes + 8), ...ascii('mdat')]),
    ...samples.map((s) => s.data),
  ];
}

export function concat(pieces: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}
