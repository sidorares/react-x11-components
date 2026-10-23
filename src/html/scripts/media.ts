// What a media resource's container says of it before it is played: how
// long it is and, for a video, how large (HTML 4.8.11.5, "once enough of
// the media data has been fetched to determine the duration"). The host
// reads it here as a page's media element fetches its source
// (`DomHost._mediaFetch`), so another origin's bytes, which the page may
// not read, never reach the page's realm: the page hears the duration,
// the size and how much has arrived, as a browser tells it. ISO BMFF,
// Matroska and WebM, MPEG audio, RIFF WAVE and Ogg.

/** How far past its metadata a source is read before it can play
 *  through: what a player would have buffered. */
export const MEDIA_ENOUGH = 64 * 1024;
/** A source whose container says nothing in this much is read as having
 *  no known length. */
export const MEDIA_MOST = 16 * 1024 * 1024;

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  /** Where the metadata ends, in bytes from the start. */
  end: number;
}
/** What a container's head says (`mediaInfoOf`): the info, `'more'`
 *  where it has not all arrived, or null for no container read here. */
export type MediaHead = MediaInfo | 'more' | null;
const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const le32 = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const fourCC = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** ISO BMFF (`.mp4`, `.m4a`, `.mov`): the `moov` box's `mvhd` and the
 *  first visual track's `tkhd`. */
const mp4Head = (b: Uint8Array, n: number, complete: boolean): MediaHead => {
  /** The boxes from `start` to `end`, each its type and its content. */
  const boxes = (start: number, end: number) => {
    const out: { type: string; at: number; end: number }[] = [];
    let at = start;
    while (at + 8 <= end) {
      let size = u32(b, at);
      let head = 8;
      if (size === 1) {
        if (at + 16 > end) break;
        size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12);
        head = 16;
      } else if (size === 0) size = end - at;
      if (size < head) break;
      out.push({ type: fourCC(b, at + 4), at: at + head, end: at + size });
      at += size;
    }
    return out;
  };
  let at = 0;
  while (at + 8 <= n) {
    let size = u32(b, at);
    const type = fourCC(b, at + 4);
    let head = 8;
    if (size === 1) {
      if (at + 16 > n) break;
      size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12);
      head = 16;
    } else if (size === 0) size = Infinity;
    if (size < head) return null;
    if (at === 0 && type !== 'ftyp' && type !== 'moov') return null;
    if (type === 'moov') {
      if (at + size > n) return complete ? null : 'more';
      const info: MediaInfo = {
        duration: NaN,
        width: 0,
        height: 0,
        end: at + size,
      };
      for (const box of boxes(at + head, at + size)) {
        if (box.type === 'mvhd') {
          const v1 = b[box.at] === 1;
          const scale = u32(b, box.at + (v1 ? 20 : 12));
          const length = v1
            ? u32(b, box.at + 24) * 2 ** 32 + u32(b, box.at + 28)
            : u32(b, box.at + 16);
          const unknown = v1
            ? u32(b, box.at + 24) === 0xffffffff
            : length === 0xffffffff;
          if (scale) info.duration = unknown ? Infinity : length / scale;
        } else if (box.type === 'trak' && !info.width) {
          for (const inner of boxes(box.at, box.end)) {
            if (inner.type !== 'tkhd') continue;
            const v1 = b[inner.at] === 1;
            info.width = u32(b, inner.at + (v1 ? 88 : 76)) / 65536;
            info.height = u32(b, inner.at + (v1 ? 92 : 80)) / 65536;
          }
        }
      }
      return info;
    }
    if (!Number.isFinite(size)) return null;
    at += size;
  }
  return complete ? null : 'more';
};

/** Matroska and WebM: the segment's `Info` (its timecode scale and
 *  duration) and the first video track's pixel size, up to its first
 *  cluster. */
const webmHead = (b: Uint8Array, n: number, complete: boolean): MediaHead => {
  /** An element's ID, its size (-1 unknown) and where its data starts. */
  const element = (at: number) => {
    if (at >= n) return null;
    const idLength = Math.clz32(b[at]) - 23;
    if (idLength < 1 || idLength > 4 || at + idLength >= n) return null;
    let id = 0;
    for (let i = 0; i < idLength; i += 1) id = id * 256 + b[at + i];
    const s = at + idLength;
    const sizeLength = Math.clz32(b[s]) - 23;
    if (sizeLength < 1 || sizeLength > 8 || s + sizeLength > n) return null;
    let size = b[s] & (0xff >> sizeLength);
    let ones = size === 0xff >> sizeLength;
    for (let i = 1; i < sizeLength; i += 1) {
      size = size * 256 + b[s + i];
      ones &&= b[s + i] === 0xff;
    }
    return { id, size: ones ? -1 : size, data: s + sizeLength };
  };
  const uint = (at: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i += 1) v = v * 256 + b[at + i];
    return v;
  };
  const float = (at: number, size: number): number => {
    const view = new DataView(b.buffer, b.byteOffset + at, size);
    return size === 4 ? view.getFloat32(0) : view.getFloat64(0);
  };
  const header = element(0);
  if (!header || header.id !== 0x1a45dfa3 || header.size < 0) {
    return header || n >= 4 ? null : complete ? null : 'more';
  }
  const segment = element(header.data + header.size);
  if (!segment) return complete ? null : 'more';
  if (segment.id !== 0x18538067) return null;
  let scale = 1e6;
  let length = NaN;
  let width = 0;
  let height = 0;
  let info = false;
  let tracks = false;
  const segmentEnd = segment.size < 0 ? Infinity : segment.data + segment.size;
  let at = segment.data;
  let end = -1;
  const within = (data: number, size: number) => {
    const out: { id: number; size: number; data: number }[] = [];
    let i = data;
    while (i < data + size) {
      const e = element(i);
      if (!e || e.size < 0) break;
      out.push(e);
      i = e.data + e.size;
    }
    return out;
  };
  while (at < segmentEnd) {
    const e = element(at);
    if (!e) break;
    if (e.id === 0x1f43b675) {
      end = at;
      break;
    }
    if (e.size < 0) return null;
    if (e.id === 0x1549a966 || e.id === 0x1654ae6b) {
      if (e.data + e.size > n) break;
      if (e.id === 0x1549a966) {
        info = true;
        for (const c of within(e.data, e.size)) {
          if (c.id === 0x2ad7b1) scale = uint(c.data, c.size);
          else if (c.id === 0x4489) length = float(c.data, c.size);
        }
      } else {
        tracks = true;
        for (const entry of within(e.data, e.size)) {
          if (entry.id !== 0xae || width) continue;
          for (const c of within(entry.data, entry.size)) {
            if (c.id !== 0xe0) continue;
            for (const v of within(c.data, c.size)) {
              if (v.id === 0xb0) width = uint(v.data, v.size);
              else if (v.id === 0xba) height = uint(v.data, v.size);
            }
          }
        }
      }
    }
    at = e.data + e.size;
    if (info && tracks) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    if (!complete) return 'more';
    if (!info) return null;
    end = n;
  }
  return {
    // a segment that says no duration is a stream's
    duration: Number.isNaN(length) ? Infinity : (length * scale) / 1e9,
    width,
    height,
    end,
  };
};

/** MPEG audio (`.mp3`): the first frame's header, and the frame count a
 *  Xing, an Info or a VBRI header gives — or the bit rate across the
 *  rest of the resource. */
const mp3Head = (
  b: Uint8Array,
  n: number,
  complete: boolean,
  total: number | null,
): MediaHead => {
  let at = 0;
  if (n < 10) return complete ? null : 'more';
  if (fourCC(b, 0).slice(0, 3) === 'ID3') {
    at =
      10 +
      ((b[6] & 0x7f) << 21) +
      ((b[7] & 0x7f) << 14) +
      ((b[8] & 0x7f) << 7) +
      (b[9] & 0x7f) +
      (b[5] & 0x10 ? 10 : 0);
  }
  const limit = Math.min(n, at + 4096);
  while (at + 4 <= limit && !(b[at] === 0xff && (b[at + 1] & 0xe0) === 0xe0)) {
    at += 1;
  }
  if (at + 4 > n) return complete ? null : 'more';
  if (at + 4 > limit) return null;
  const version = (b[at + 1] >> 3) & 3;
  const layer = (b[at + 1] >> 1) & 3;
  const rateIndex = b[at + 2] >> 4;
  const srIndex = (b[at + 2] >> 2) & 3;
  if (version === 1 || layer === 0 || rateIndex === 15 || srIndex === 3) {
    return null;
  }
  const mpeg1 = version === 3;
  const rates =
    [44100, 48000, 32000][srIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const kbps = (
    mpeg1
      ? layer === 3
        ? [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
        : layer === 2
          ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
          : [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : layer === 3
        ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  )[rateIndex];
  const samples = layer === 3 ? 384 : layer === 2 || mpeg1 ? 1152 : 576;
  const mono = b[at + 3] >> 6 === 3;
  const side = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  if (at + 4 + side + 12 > n) return complete ? null : 'more';
  const tag = fourCC(b, at + 4 + side);
  let frames = 0;
  if ((tag === 'Xing' || tag === 'Info') && u32(b, at + 8 + side) & 1) {
    frames = u32(b, at + 12 + side);
  } else if (at + 36 + 18 <= n && fourCC(b, at + 36) === 'VBRI') {
    frames = u32(b, at + 36 + 14);
  }
  const duration = frames
    ? (frames * samples) / rates
    : total !== null && kbps
      ? ((total - at) * 8) / (kbps * 1000)
      : complete && kbps
        ? ((n - at) * 8) / (kbps * 1000)
        : Infinity;
  return { duration, width: 0, height: 0, end: at + 4 };
};

/** RIFF WAVE: the format's byte rate over the data chunk's length. */
const wavHead = (b: Uint8Array, n: number, complete: boolean): MediaHead => {
  let at = 12;
  let rate = 0;
  while (at + 8 <= n) {
    const id = fourCC(b, at);
    const size = le32(b, at + 4);
    if (id === 'fmt ') {
      if (at + 20 > n) break;
      rate = le32(b, at + 16);
    } else if (id === 'data') {
      if (!rate) return null;
      return { duration: size / rate, width: 0, height: 0, end: at + 8 };
    }
    at += 8 + size + (size & 1);
  }
  return complete ? null : 'more';
};

/** Ogg (Vorbis, Opus): the first page's sampling rate, and the last
 *  page's granule position, so once all of it is in. */
const oggHead = (b: Uint8Array, n: number, complete: boolean): MediaHead => {
  if (!complete) return 'more';
  if (n < 28 + 19) return null;
  const packet = 27 + b[26];
  let rate = 0;
  let skip = 0;
  if (fourCC(b, packet + 1) === 'vorb') rate = le32(b, packet + 12);
  else if (fourCC(b, packet) === 'Opus') {
    rate = 48000;
    skip = b[packet + 10] | (b[packet + 11] << 8);
  }
  if (!rate) return null;
  for (let at = n - 27; at >= 0; at -= 1) {
    if (b[at] !== 0x4f || fourCC(b, at) !== 'OggS') continue;
    const granule = le32(b, at + 6) + le32(b, at + 10) * 2 ** 32;
    return {
      duration: Math.max(0, granule - skip) / rate,
      width: 0,
      height: 0,
      end: n,
    };
  }
  return null;
};

/** What a source's first bytes say it is, and so what its container's
 *  head says (`MediaHead`). */
export const mediaInfoOf = (
  b: Uint8Array,
  n: number,
  complete: boolean,
  total: number | null,
): MediaHead => {
  if (n < 12) return complete ? null : 'more';
  const tag = fourCC(b, 0);
  if (tag === 'RIFF' && fourCC(b, 8) === 'WAVE') {
    return wavHead(b, n, complete);
  }
  if (tag === 'OggS') return oggHead(b, n, complete);
  if (u32(b, 0) === 0x1a45dfa3) return webmHead(b, n, complete);
  if (fourCC(b, 4) === 'ftyp' || fourCC(b, 4) === 'moov') {
    return mp4Head(b, n, complete);
  }
  if (tag.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) {
    return mp3Head(b, n, complete, total);
  }
  return null;
};

/** A source as it arrives: its bytes kept until its head is read, and
 *  counted after. */
export class MediaReader {
  private _bytes = new Uint8Array(64 * 1024);
  private _n = 0;
  info: MediaInfo | null = null;
  constructor(private readonly _total: number | null) {}

  /** How many bytes have arrived. */
  get received(): number {
    return this._n;
  }

  add(chunk: Uint8Array): void {
    if (!this.info) {
      if (this._n + chunk.length > this._bytes.length) {
        const grown = new Uint8Array(
          Math.max(this._bytes.length * 2, this._n + chunk.length),
        );
        grown.set(this._bytes.subarray(0, this._n));
        this._bytes = grown;
      }
      this._bytes.set(chunk, this._n);
    }
    this._n += chunk.length;
  }

  /** What has arrived comes to, `complete` where it is all there is. */
  read(complete: boolean): MediaHead {
    if (this.info) return this.info;
    const head =
      this._n > MEDIA_MOST
        ? { duration: Infinity, width: 0, height: 0, end: this._n }
        : mediaInfoOf(this._bytes, this._n, complete, this._total);
    if (head && head !== 'more') {
      this.info = head;
      this._bytes = new Uint8Array(0);
    }
    return head;
  }
}
