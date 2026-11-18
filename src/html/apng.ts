// An animated PNG, as RGBA: each of its frames in turn.
//
// A PNG's default image is core's to decode (`decodeImageBytes`), and that
// is all core decodes of an APNG. The rest is read here, the way `webp.ts`
// reads an animated WebP's: `readApng` finds the frames (the `acTL`, `fcTL`
// and `fdAT` chunks of PNG's third edition) and what each says about
// itself, and `ApngCanvas` draws them onto the canvas one after another,
// each blended or not and disposed of as its `fcTL` says.
//
// A frame's pixels are not decoded here either. A frame is a still PNG of
// its own size (`stillOf`): the image's `IHDR` at the frame's size, the
// chunks before the image data that every frame shares (a palette, its
// transparency, a gamma), and the frame's `fdAT` data as `IDAT`. That is
// handed to the decoder the caller has, image-in-browser's.

/** One frame of an animated PNG. */
export interface ApngFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** How long the frame is shown, in milliseconds, as a browser shows it:
   *  10 ms or less is 100 ms, as in Chrome and Firefox. */
  delay: number;
  /** Whether the frame is alpha-blended over the canvas (`APNG_BLEND_OP_OVER`)
   *  rather than replacing what its rectangle covers. */
  blend: boolean;
  /** What becomes of the frame's rectangle once it has been shown: left
   *  (0), cleared to transparent (1) or put back as it was before (2). */
  dispose: 0 | 1 | 2;
  /** The frame as a still PNG. */
  data: Uint8Array;
}

/** An animated PNG's canvas and frames. */
export interface ApngFile {
  width: number;
  height: number;
  frames: ApngFrame[];
  /** How many times the frames are played through: `acTL`'s `num_plays`,
   *  `Infinity` where it is 0. */
  plays: number;
}

/** A decoder of a still PNG into straight RGBA, `width * height * 4`. */
export type DecodePng = (
  bytes: Uint8Array,
) => { width: number; height: number; data: Uint8Array } | null;

/** The most pixels a canvas may say it has: past this a malformed header is
 *  a request for gigabytes, not an image. */
const MAX_PIXELS = 1 << 25;

const FASTEST_DELAY_MS = 10;
const FAST_DELAY_MS = 100;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32 = (b: Uint8Array, at: number) =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const tag = (b: Uint8Array, at: number) =>
  String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

interface Control {
  seq: number;
  frame: Omit<ApngFrame, 'data'>;
  parts: Uint8Array[];
}

/**
 * Read an animated PNG's canvas and frames, or null for bytes that are not
 * one — a still PNG among them — or that break its rules, which a browser
 * shows as their default image: an `acTL` after the image data, a frame
 * out of the canvas, sequence numbers out of order, or fewer frames than
 * `acTL` says.
 */
export function readApng(bytes: Uint8Array): ApngFile | null {
  if (bytes.length < 33) return null;
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== SIGNATURE[i]) return null;
  if (tag(bytes, 12) !== 'IHDR') return null;
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  if (!width || !height || width * height > MAX_PIXELS) return null;
  const ihdr = bytes.subarray(16, 29);
  /** The chunks between `IHDR` and the image data each frame shares. */
  const shared: Uint8Array[] = [];
  let count = 0;
  let plays = Infinity;
  let seenData = false;
  let animated = false;
  let nextSeq = 0;
  const controls: Control[] = [];
  let current: Control | null = null;
  for (let at = 8; at + 12 <= bytes.length;) {
    const size = u32(bytes, at);
    const name = tag(bytes, at + 4);
    const body = at + 8;
    if (body + size + 4 > bytes.length) break;
    const data = bytes.subarray(body, body + size);
    if (name === 'IEND') break;
    if (name === 'acTL') {
      if (seenData || size < 8) return null;
      count = u32(data, 0);
      const n = u32(data, 4);
      plays = n === 0 ? Infinity : n;
      animated = true;
    } else if (name === 'fcTL') {
      if (size < 26 || u32(data, 0) !== nextSeq) return null;
      nextSeq += 1;
      const frame = {
        width: u32(data, 4),
        height: u32(data, 8),
        left: u32(data, 12),
        top: u32(data, 16),
        delay: delayOf(u16(data, 20), u16(data, 22)),
        dispose: (data[24] <= 2 ? data[24] : 0) as 0 | 1 | 2,
        blend: data[25] === 1,
      };
      if (
        !frame.width ||
        !frame.height ||
        frame.left + frame.width > width ||
        frame.top + frame.height > height
      ) {
        return null;
      }
      // the first frame is the default image where it comes before the
      // image data, and it covers the whole canvas
      if (!seenData && controls.length === 0) {
        if (frame.width !== width || frame.height !== height) return null;
      }
      current = { seq: nextSeq - 1, frame, parts: [] };
      controls.push(current);
    } else if (name === 'IDAT') {
      // image data belongs to a frame only where an fcTL came first
      if (!seenData && current && controls.length === 1) {
        current.parts.push(data);
      }
      seenData = true;
    } else if (name === 'fdAT') {
      if (size < 4 || u32(data, 0) !== nextSeq) return null;
      nextSeq += 1;
      if (current && seenData) current.parts.push(data.subarray(4));
    } else if (!seenData && name !== 'fcTL' && name !== 'acTL') {
      if (name !== 'IHDR') shared.push(bytes.subarray(at, body + size + 4));
    }
    at = body + size + 4;
  }
  if (!animated || controls.length === 0 || controls.length !== count) {
    return null;
  }
  const frames: ApngFrame[] = [];
  for (const control of controls) {
    if (!control.parts.length) return null;
    frames.push({
      ...control.frame,
      data: stillOf(ihdr, shared, control.frame, control.parts),
    });
  }
  // a first frame put back as it was before is cleared, since there is
  // nothing before it (PNG 3, 11.3.3.2)
  if (frames[0].dispose === 2) frames[0].dispose = 1;
  return { width, height, frames, plays };
}

function delayOf(num: number, den: number): number {
  const ms = (num * 1000) / (den || 100);
  return ms <= FASTEST_DELAY_MS ? FAST_DELAY_MS : ms;
}

/** A frame's data as a still PNG of the frame's size. */
function stillOf(
  ihdr: Uint8Array,
  shared: readonly Uint8Array[],
  frame: { width: number; height: number },
  parts: readonly Uint8Array[],
): Uint8Array {
  let length = 8 + 25 + 12;
  for (const chunk of shared) length += chunk.length;
  for (const part of parts) length += 12 + part.length;
  const out = new Uint8Array(length);
  out.set(SIGNATURE, 0);
  let at = 8;
  const chunk = (name: string, data: Uint8Array) => {
    put32(out, at, data.length);
    for (let i = 0; i < 4; i += 1) out[at + 4 + i] = name.charCodeAt(i);
    out.set(data, at + 8);
    put32(
      out,
      at + 8 + data.length,
      crc32(out.subarray(at + 4, at + 8 + data.length)),
    );
    at += 12 + data.length;
  };
  const header = ihdr.slice();
  put32(header, 0, frame.width);
  put32(header, 4, frame.height);
  chunk('IHDR', header);
  for (const kept of shared) {
    out.set(kept, at);
    at += kept.length;
  }
  for (const part of parts) chunk('IDAT', part);
  chunk('IEND', new Uint8Array(0));
  return out;
}

let crcTable: Uint32Array | null = null;

/** PNG's CRC of a chunk's name and data. */
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function put32(out: Uint8Array, at: number, n: number): void {
  out[at] = (n >>> 24) & 0xff;
  out[at + 1] = (n >>> 16) & 0xff;
  out[at + 2] = (n >>> 8) & 0xff;
  out[at + 3] = n & 0xff;
}

/**
 * The canvas an animated PNG's frames are drawn on, one after another, as
 * `WebPCanvas` draws a WebP's: `at` answers the canvas once a frame is
 * drawn, which the caller copies, since the next `at` draws over it. A
 * frame that does not decode leaves the canvas as it was.
 */
export class ApngCanvas {
  private readonly _file: ApngFile;
  private readonly _decode: DecodePng;
  private readonly _data: Uint8Array;
  private _index = -1;
  /** What a frame disposed to `previous` covered before it was drawn. */
  private _saved: Uint8Array | null = null;

  constructor(file: ApngFile, decode: DecodePng) {
    this._file = file;
    this._decode = decode;
    this._data = new Uint8Array(file.width * file.height * 4);
  }

  at(index: number): Uint8Array {
    if (index < this._index) {
      this._data.fill(0);
      this._index = -1;
      this._saved = null;
    }
    while (this._index < index) this._step();
    return this._data;
  }

  private _step(): void {
    const { frames, width } = this._file;
    const data = this._data;
    const last = frames[this._index];
    if (last?.dispose === 1) {
      for (let y = last.top; y < last.top + last.height; y += 1) {
        const o = (y * width + last.left) * 4;
        data.fill(0, o, o + last.width * 4);
      }
    } else if (last?.dispose === 2 && this._saved) {
      const row = last.width * 4;
      for (let y = 0; y < last.height; y += 1) {
        const o = ((last.top + y) * width + last.left) * 4;
        data.set(this._saved.subarray(y * row, y * row + row), o);
      }
    }
    this._saved = null;
    this._index += 1;
    const frame = frames[this._index];
    if (frame.dispose === 2) {
      const row = frame.width * 4;
      const saved = new Uint8Array(row * frame.height);
      for (let y = 0; y < frame.height; y += 1) {
        const o = ((frame.top + y) * width + frame.left) * 4;
        saved.set(data.subarray(o, o + row), y * row);
      }
      this._saved = saved;
    }
    const decoded = this._decode(frame.data);
    if (
      !decoded ||
      decoded.width !== frame.width ||
      decoded.height !== frame.height
    ) {
      return;
    }
    const src = decoded.data;
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const s = (y * frame.width + x) * 4;
        const o = ((frame.top + y) * width + frame.left + x) * 4;
        const a = src[s + 3];
        if (!frame.blend || a === 255 || data[o + 3] === 0) {
          data[o] = src[s];
          data[o + 1] = src[s + 1];
          data[o + 2] = src[s + 2];
          data[o + 3] = a;
          continue;
        }
        if (a === 0) continue;
        // source over, in straight alpha
        const under = (data[o + 3] * (255 - a)) / 255;
        const out = a + under;
        for (let c = 0; c < 3; c += 1) {
          data[o + c] = Math.round(
            (src[s + c] * a + data[o + c] * under) / out,
          );
        }
        data[o + 3] = Math.round(out);
      }
    }
  }
}
