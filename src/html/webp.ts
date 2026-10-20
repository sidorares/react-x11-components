// An animated WebP, as RGBA: each of its frames in turn.
//
// A still WebP is core's to decode (`decodeImageBytes`), and core decodes an
// animation's first frame. The rest is read here, the way `gif.ts` reads a
// GIF's: `readAnimatedWebP` finds the frames in the RIFF container (the
// `ANIM` and `ANMF` chunks of the WebP Container Specification) and what
// each says about itself, and `WebPCanvas` draws them onto the canvas one
// after another, each blended or not and disposed of as its flags say.
//
// The pixels of a frame are not decoded here. A frame's data is a still
// image's — a `VP8 ` or a `VP8L` chunk, and an `ALPH` before a `VP8 ` — so
// it is wrapped as a still WebP (`stillOf`) and handed to the decoder the
// caller has, image-in-browser's, which core decodes WebP with under Node.
// That decoder can play an animation too, and gets two things wrong that a
// page can see: it blends every frame, where a frame may ask to replace what
// is under it, and it disposes of a frame by clearing the whole canvas
// before that frame is drawn, where the flag says to clear the frame's own
// rectangle after it is shown.

/** One frame of an animated WebP. */
export interface WebPFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** How long the frame is shown, in milliseconds, as a browser shows it:
   *  10 ms or less is 100 ms, as in Chrome and Firefox. */
  delay: number;
  /** Whether the frame is alpha-blended over the canvas, rather than
   *  replacing what its rectangle covers. */
  blend: boolean;
  /** Whether the frame's rectangle is cleared to transparent once it has
   *  been shown — to transparent, as browsers clear it, and not to the
   *  background colour the `ANIM` chunk names, which they ignore. */
  dispose: boolean;
  /** The frame's image data: its `ALPH`, `VP8 ` or `VP8L` chunks. */
  data: Uint8Array;
}

/** An animated WebP's canvas and frames. */
export interface WebPFile {
  width: number;
  height: number;
  frames: WebPFrame[];
  /** How many times the frames are played through: the `ANIM` chunk's loop
   *  count, `Infinity` where it is 0. Unlike a GIF's, a WebP's count is
   *  the plays and not the repeats after the first. */
  plays: number;
}

/** A decoder of a still WebP into straight RGBA, `width * height * 4`. */
export type DecodeStill = (
  bytes: Uint8Array,
) => { width: number; height: number; data: Uint8Array } | null;

/** The most pixels a canvas may say it has: past this a malformed header is
 *  a request for gigabytes, not an image. */
const MAX_PIXELS = 1 << 25;

const FASTEST_DELAY_MS = 10;
const FAST_DELAY_MS = 100;

const u24 = (b: Uint8Array, at: number) =>
  b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const tag = (b: Uint8Array, at: number) =>
  String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/**
 * Read an animated WebP's canvas and frames, or null for bytes that are
 * not one — a still WebP among them, which is core's to decode. Data that
 * ends early ends the frames there.
 */
export function readAnimatedWebP(bytes: Uint8Array): WebPFile | null {
  if (
    bytes.length < 30 ||
    tag(bytes, 0) !== 'RIFF' ||
    tag(bytes, 8) !== 'WEBP' ||
    tag(bytes, 12) !== 'VP8X' ||
    (bytes[20] & 0x02) === 0
  ) {
    return null;
  }
  const width = u24(bytes, 24) + 1;
  const height = u24(bytes, 27) + 1;
  if (width * height > MAX_PIXELS) return null;
  const end = Math.min(bytes.length, 8 + u32(bytes, 4));
  const frames: WebPFrame[] = [];
  let plays = Infinity;
  for (let at = 12; at + 8 <= end;) {
    const name = tag(bytes, at);
    const size = u32(bytes, at + 4);
    const body = at + 8;
    if (body + size > end) break;
    if (name === 'ANIM' && size >= 6) {
      const loops = bytes[body + 4] | (bytes[body + 5] << 8);
      plays = loops === 0 ? Infinity : loops;
    } else if (name === 'ANMF' && size >= 16) {
      const delay = u24(bytes, body + 12);
      const flags = bytes[body + 15];
      const frame: WebPFrame = {
        left: u24(bytes, body) * 2,
        top: u24(bytes, body + 3) * 2,
        width: u24(bytes, body + 6) + 1,
        height: u24(bytes, body + 9) + 1,
        delay: delay <= FASTEST_DELAY_MS ? FAST_DELAY_MS : delay,
        blend: (flags & 0x02) === 0,
        dispose: (flags & 0x01) !== 0,
        data: bytes.subarray(body + 16, body + size),
      };
      if (frame.width * frame.height > MAX_PIXELS) break;
      frames.push(frame);
    }
    at = body + size + (size & 1);
  }
  return frames.length ? { width, height, frames, plays } : null;
}

/**
 * A frame's data as a still WebP of its own: the chunks under a RIFF
 * header, and a `VP8X` before them where there is an `ALPH`, which a
 * decoder reads only in the extended format.
 */
export function stillOf(frame: WebPFrame): Uint8Array {
  const alpha = frame.data.length >= 4 && tag(frame.data, 0) === 'ALPH';
  const head = alpha ? 18 : 0;
  const out = new Uint8Array(12 + head + frame.data.length);
  const put = (at: number, text: string) => {
    for (let i = 0; i < 4; i += 1) out[at + i] = text.charCodeAt(i);
  };
  const put32 = (at: number, n: number) => {
    out[at] = n & 0xff;
    out[at + 1] = (n >> 8) & 0xff;
    out[at + 2] = (n >> 16) & 0xff;
    out[at + 3] = (n >>> 24) & 0xff;
  };
  put(0, 'RIFF');
  put32(4, out.length - 8);
  put(8, 'WEBP');
  if (alpha) {
    put(12, 'VP8X');
    put32(16, 10);
    out[20] = 0x10; // alpha
    const w = frame.width - 1;
    const h = frame.height - 1;
    out.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
    out.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  }
  out.set(frame.data, 12 + head);
  return out;
}

/**
 * The canvas an animated WebP's frames are drawn on, one after another, as
 * `GifCanvas` draws a GIF's: `at` answers the canvas once a frame is drawn,
 * which the caller copies, since the next `at` draws over it. A frame that
 * does not decode leaves the canvas as it was.
 */
export class WebPCanvas {
  private readonly _file: WebPFile;
  private readonly _decode: DecodeStill;
  private readonly _data: Uint8Array;
  private _index = -1;

  constructor(file: WebPFile, decode: DecodeStill) {
    this._file = file;
    this._decode = decode;
    this._data = new Uint8Array(file.width * file.height * 4);
  }

  at(index: number): Uint8Array {
    if (index < this._index) {
      this._data.fill(0);
      this._index = -1;
    }
    while (this._index < index) this._step();
    return this._data;
  }

  private _step(): void {
    const { frames, width, height } = this._file;
    const data = this._data;
    const last = frames[this._index];
    if (last?.dispose) {
      eachPixel(this._file, last, (o) => data.fill(0, o, o + 4));
    }
    this._index += 1;
    const frame = frames[this._index];
    const decoded = this._decode(stillOf(frame));
    if (!decoded) return;
    const right = Math.min(width, frame.left + decoded.width);
    const bottom = Math.min(height, frame.top + decoded.height);
    const src = decoded.data;
    for (let y = frame.top; y < bottom; y += 1) {
      for (let x = frame.left; x < right; x += 1) {
        const s = ((y - frame.top) * decoded.width + (x - frame.left)) * 4;
        const o = (y * width + x) * 4;
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

function eachPixel(
  file: WebPFile,
  frame: WebPFrame,
  each: (offset: number) => void,
): void {
  const right = Math.min(file.width, frame.left + frame.width);
  const bottom = Math.min(file.height, frame.top + frame.height);
  for (let y = frame.top; y < bottom; y += 1) {
    for (let x = frame.left; x < right; x += 1) each((y * file.width + x) * 4);
  }
}
