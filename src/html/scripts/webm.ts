// WebM as a page appends it to a `MediaSource`, read as far as `mp4.ts` needs
// it: the video track's size and colours, how long the stream says it is, and
// each VP9 packet with its time. Nothing here decodes a frame.
//
// **It is read as it arrives.** A page appends what its `fetch` hands it, so a
// chunk ends wherever the network ended it, in the middle of a block or of an
// element's size. `WebmReader.push` takes what it can and keeps the rest.
//
// **Masters are walked into, not read whole.** A Segment or a Cluster may be
// as long as the stream, or say it does not know how long it is, which a
// muxer writing to a pipe does; only their children have to be there before
// they are read. So the walk needs no stack: the masters that matter are
// entered by reading past their heads (`INTO`), and the leaves are read or
// skipped one at a time.

/** Element ids, as they are written. */
const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const COLOUR = 0x55b0;
const MATRIX = 0x55b1;
const RANGE = 0x55b9;
const TRANSFER = 0x55ba;
const PRIMARIES = 0x55bb;
const CLUSTER = 0x1f43b675;
const TIMESTAMP = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;

const INTO = new Set([
  SEGMENT,
  INFO,
  TRACKS,
  TRACK_ENTRY,
  VIDEO,
  COLOUR,
  CLUSTER,
  BLOCK_GROUP,
]);

/** The largest leaf read whole: a block past this is no video's. */
const MOST_ELEMENT = 256 * 1024 * 1024;

/** A track's colours as ISO/IEC 23091 numbers them, where its entry says. */
export interface WebmColour {
  primaries?: number;
  transfer?: number;
  matrix?: number;
  /** 1 video range, 2 full range. */
  range?: number;
}

/** The video track a stream has. */
export interface WebmVideo {
  width: number;
  height: number;
  colour: WebmColour;
}

/** One block of the video track. */
export interface WebmPacket {
  /** Seconds from the stream's start. */
  time: number;
  /** Its bytes, a copy the reader keeps no hold on. */
  data: Uint8Array;
}

interface Track {
  number: number;
  type: number;
  codec: string;
  width: number;
  height: number;
  colour: WebmColour;
}

const NEW_TRACK = (): Track => ({
  number: 0,
  type: 0,
  codec: '',
  width: 0,
  height: 0,
  colour: {},
});

export class WebmReader {
  /** The video track, once the stream has said what it is. */
  video: WebmVideo | null = null;
  /** The stream's length in seconds, where it says. */
  duration: number | null = null;
  /** Set where what arrived cannot be WebM, or holds no VP9 track. */
  failed = false;

  private _bytes = new Uint8Array(1 << 16);
  private _from = 0;
  private _to = 0;
  /** What of an element nobody reads has still to come. */
  private _skipping = 0;
  private _scale = 1_000_000;
  private _cluster = 0;
  private _track: Track | null = null;
  private _videoTrack = 0;
  private _started = false;
  /** What has been let go of `_bytes`, so that a place in the stream is
   *  `_gone + _from`. */
  private _gone = 0;
  /** Where the stream's Tracks end, where they say: an init segment on its
   *  own has no cluster after it to say so. */
  private _tracksEnd = Infinity;

  /** The chunk, and the packets it completed. */
  push(chunk: Uint8Array): WebmPacket[] {
    const packets: WebmPacket[] = [];
    if (this.failed) return packets;
    this._keep(chunk);
    while (this._step(packets)) {
      if (this._gone + this._from >= this._tracksEnd) {
        this._tracksEnd = Infinity;
        this._endTrack();
      }
    }
    return packets;
  }

  private _keep(chunk: Uint8Array): void {
    const held = this._to - this._from;
    if (this._to + chunk.length > this._bytes.length) {
      const room = held + chunk.length;
      const to =
        room > this._bytes.length
          ? new Uint8Array(Math.max(room, this._bytes.length * 2))
          : this._bytes;
      if (to === this._bytes) to.copyWithin(0, this._from, this._to);
      else to.set(this._bytes.subarray(this._from, this._to));
      this._bytes = to;
      this._gone += this._from;
      this._from = 0;
      this._to = held;
    }
    this._bytes.set(chunk, this._to);
    this._to += chunk.length;
  }

  /** How long the number at `at` is, by its first byte: 0 where that has
   *  not come, and past 8 where it is no number. */
  private _vint(at: number): number {
    if (at >= this._to) return 0;
    const first = this._bytes[at];
    let length = 1;
    for (let mask = 0x80; length <= 8 && !(first & mask); mask >>= 1) {
      length += 1;
    }
    return length;
  }

  /** One element's head, and it read or walked into. False where it needs
   *  bytes that have not come. */
  private _step(packets: WebmPacket[]): boolean {
    if (this._skipping) {
      const past = Math.min(this._skipping, this._to - this._from);
      this._from += past;
      this._skipping -= past;
      if (this._skipping) return false;
    }
    const at = this._from;
    const idLength = this._vint(at);
    if (!idLength) return false;
    if (idLength > 4) return this._fail();
    if (at + idLength > this._to) return false;
    const sizeAt = at + idLength;
    const sizeLength = this._vint(sizeAt);
    if (!sizeLength) return false;
    if (sizeLength > 8) return this._fail();
    if (sizeAt + sizeLength > this._to) return false;
    let id = 0;
    for (let i = 0; i < idLength; i += 1) {
      id = id * 256 + this._bytes[at + i];
    }
    if (!this._started) {
      if (id !== EBML) return this._fail();
      this._started = true;
    }
    const size = this._size(sizeAt, sizeLength);
    if (INTO.has(id)) {
      this._from = sizeAt + sizeLength;
      if (id === TRACKS && size >= 0) {
        this._tracksEnd = this._gone + this._from + size;
      }
      if (id === TRACK_ENTRY) {
        this._endTrack();
        this._track = NEW_TRACK();
      }
      if (id === CLUSTER) this._endTrack();
      return true;
    }
    if (size < 0 || size > MOST_ELEMENT) return this._fail();
    const start = sizeAt + sizeLength;
    if (!READ.has(id)) {
      this._from = start;
      this._skipping = size;
      return true;
    }
    if (start + size > this._to) return false;
    this._read(id, start, size, packets);
    this._from = start + size;
    return true;
  }

  private _fail(): false {
    this.failed = true;
    return false;
  }

  /** A size, or -1 for "not known", every bit of it set. */
  private _size(at: number, length: number): number {
    let value = this._bytes[at] & (0xff >> length);
    let known = value !== 0xff >> length;
    for (let i = 1; i < length; i += 1) {
      const byte = this._bytes[at + i];
      value = value * 256 + byte;
      if (byte !== 0xff) known = true;
    }
    return known ? value : -1;
  }

  private _uint(at: number, size: number): number {
    let value = 0;
    for (let i = 0; i < size; i += 1) value = value * 256 + this._bytes[at + i];
    return value;
  }

  private _float(at: number, size: number): number {
    const view = new DataView(
      this._bytes.buffer,
      this._bytes.byteOffset + at,
      size,
    );
    if (size === 4) return view.getFloat32(0);
    return size === 8 ? view.getFloat64(0) : NaN;
  }

  private _read(
    id: number,
    at: number,
    size: number,
    packets: WebmPacket[],
  ): void {
    const track = this._track;
    switch (id) {
      case TIMESTAMP_SCALE:
        this._scale = this._uint(at, size);
        break;
      case DURATION: {
        const ticks = this._float(at, size);
        if (Number.isFinite(ticks)) {
          this.duration = (ticks * this._scale) / 1e9;
        }
        break;
      }
      case TIMESTAMP:
        this._cluster = this._uint(at, size);
        break;
      case SIMPLE_BLOCK:
      case BLOCK:
        this._block(at, size, packets);
        break;
      case TRACK_NUMBER:
        if (track) track.number = this._uint(at, size);
        break;
      case TRACK_TYPE:
        if (track) track.type = this._uint(at, size);
        break;
      case CODEC_ID:
        if (track) {
          let codec = '';
          for (let i = 0; i < size; i += 1) {
            codec += String.fromCharCode(this._bytes[at + i]);
          }
          track.codec = codec;
        }
        break;
      case PIXEL_WIDTH:
        if (track) track.width = this._uint(at, size);
        break;
      case PIXEL_HEIGHT:
        if (track) track.height = this._uint(at, size);
        break;
      case MATRIX:
        if (track) track.colour.matrix = this._uint(at, size);
        break;
      case RANGE:
        if (track) track.colour.range = this._uint(at, size);
        break;
      case TRANSFER:
        if (track) track.colour.transfer = this._uint(at, size);
        break;
      case PRIMARIES:
        if (track) track.colour.primaries = this._uint(at, size);
        break;
    }
  }

  /** A track's entry has ended: the next one's, the end of the Tracks or
   *  the first cluster says so. A second video track is passed over, and
   *  audio is not read. */
  private _endTrack(): void {
    const track = this._track;
    this._track = null;
    if (!track || this._videoTrack || track.type !== 1) return;
    if (track.codec !== 'V_VP9' || !track.width || !track.height) {
      this.failed = true;
      return;
    }
    this._videoTrack = track.number;
    this.video = {
      width: track.width,
      height: track.height,
      colour: track.colour,
    };
  }

  private _block(at: number, size: number, packets: WebmPacket[]): void {
    const numberLength = this._vint(at);
    if (!numberLength || numberLength > 8 || size < numberLength + 3) return;
    if (this._size(at, numberLength) !== this._videoTrack) return;
    const head = at + numberLength;
    const offset = ((this._bytes[head] << 24) >> 16) | this._bytes[head + 1];
    // lacing is for audio: a video block holding frames is no video's
    if (this._bytes[head + 2] & 0x06) {
      this.failed = true;
      return;
    }
    const data = this._bytes.slice(head + 3, at + size);
    if (!data.length) return;
    packets.push({
      time: ((this._cluster + offset) * this._scale) / 1e9,
      data,
    });
  }
}

/** The leaves `_read` reads: every other element is skipped as it arrives,
 *  whatever its size, so a large one holds nothing in memory. */
const READ = new Set([
  TIMESTAMP_SCALE,
  DURATION,
  TIMESTAMP,
  SIMPLE_BLOCK,
  BLOCK,
  TRACK_NUMBER,
  TRACK_TYPE,
  CODEC_ID,
  PIXEL_WIDTH,
  PIXEL_HEIGHT,
  MATRIX,
  RANGE,
  TRANSFER,
  PRIMARIES,
]);
