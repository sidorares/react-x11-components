// A GIF, as RGBA: its first frame, or each of its frames in turn.
//
// ntk decodes PNG and JPEG, and a document handed to this component is
// still full of GIFs: a mail's logo and its spacer images, a table layout's
// one-pixel shims sized by `width` and `height`, and the animations a page
// has used for a spinner or a reaction since the format had them. An image
// that does not decode is drawn as a frame, which on a spacer is a line
// through the layout that the author meant to be nothing. So the format is
// read here: GIF89a (and 87a) is small, fixed and unambiguous, and the
// decoder is the LZW variant the format defines, nothing more.
//
// `readGif` finds the frames and what each says about itself, decoding none
// of them; `GifCanvas` draws them onto the logical screen one after another,
// as each frame's disposal says to leave the screen for the next. A frame
// is only ever drawn over the one before it, so the canvas steps forwards,
// and starts again from the first to go back. When each frame is shown is
// `animated.ts`'s.

/** A decoded frame: straight RGBA, `width * height * 4` bytes — the shape
 *  ntk's `Image` is constructed from. */
export interface DecodedGif {
  width: number;
  height: number;
  data: Uint8Array;
}

/** One frame of a GIF, as the file describes it: where it goes on the
 *  logical screen, its colours, and where its image data starts. */
export interface GifFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  interlaced: boolean;
  palette: Uint8Array;
  /** The colour index not drawn, or -1. */
  transparent: number;
  /** What happens to the frame's rectangle before the next is drawn
   *  (GIF89a 23.c.iv): 0 and 1 leave it, 2 clears it, 3 puts back what was
   *  there before the frame was drawn. */
  disposal: number;
  /** How long the frame is shown, in milliseconds, as a browser shows it:
   *  a delay of 10 ms or less, which the file says to mean "as fast as you
   *  can", is 100 ms in Chrome, Firefox and Safari alike. */
  delay: number;
  minCodeSize: number;
  /** The offset of the frame's first data sub-block. */
  data: number;
}

/** A GIF's logical screen and its frames. */
export interface GifFile {
  bytes: Uint8Array;
  width: number;
  height: number;
  frames: GifFrame[];
  /**
   * How many times the frames are played through: once where the file has
   * no NETSCAPE2.0 loop extension, `Infinity` where it says 0, and its
   * count and the first play where it says more — a loop count of 1 is two
   * plays in Chrome and Firefox, which is what a GIF made for them expects.
   */
  plays: number;
}

/** The most pixels a GIF may say it has: past this a malformed header is a
 *  request for gigabytes, not an image. */
const MAX_PIXELS = 1 << 25;

/** The shortest delay a browser keeps (`GifFrame.delay`), and what it shows
 *  a shorter one for instead. */
const FASTEST_DELAY_MS = 10;
const FAST_DELAY_MS = 100;

/**
 * Read a GIF's screen and frames, or null for bytes that are not a GIF or
 * have no frame. Data that ends early ends the frames there, and a frame
 * whose image data is cut short is still one (`lzw`).
 */
export function readGif(bytes: Uint8Array): GifFile | null {
  if (
    bytes.length < 13 ||
    bytes[0] !== 0x47 || // G
    bytes[1] !== 0x49 || // I
    bytes[2] !== 0x46 || // F
    bytes[3] !== 0x38 || // 8
    (bytes[4] !== 0x37 && bytes[4] !== 0x39) || // 7 or 9
    bytes[5] !== 0x61 // a
  ) {
    return null;
  }
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  if (!width || !height || width * height > MAX_PIXELS) return null;
  const packed = bytes[10];
  let at = 13;
  let global: Uint8Array | null = null;
  if (packed & 0x80) {
    const size = 3 * (1 << ((packed & 7) + 1));
    global = bytes.subarray(at, at + size);
    at += size;
  }
  const frames: GifFrame[] = [];
  let plays = 1;
  // a Graphic Control Extension applies to the one image after it
  let transparent = -1;
  let disposal = 0;
  let delay = 0;

  while (at < bytes.length) {
    const block = bytes[at++];
    if (block === 0x3b) break; // the trailer
    if (block === 0x21) {
      const label = bytes[at++];
      if (label === 0xf9 && bytes[at] >= 4) {
        // Graphic Control: which colour is not drawn, for how long, and
        // what becomes of the frame after
        const flags = bytes[at + 1];
        transparent = flags & 1 ? bytes[at + 4] : -1;
        disposal = (flags >> 2) & 7;
        delay = (bytes[at + 2] | (bytes[at + 3] << 8)) * 10;
      } else if (
        label === 0xff &&
        bytes[at] === 11 &&
        (ascii(bytes, at + 1, 'NETSCAPE2.0') ||
          ascii(bytes, at + 1, 'ANIMEXTS1.0')) &&
        bytes[at + 12] >= 3 &&
        bytes[at + 13] === 1
      ) {
        const loops = bytes[at + 14] | (bytes[at + 15] << 8);
        plays = loops === 0 ? Infinity : loops + 1;
      }
      at = skipSubBlocks(bytes, at);
      continue;
    }
    // neither an extension nor an image: past the frames there are, the
    // rest is ignored; before them, this is not a GIF this can read
    if (block !== 0x2c || at + 9 > bytes.length) break;
    const left = bytes[at] | (bytes[at + 1] << 8);
    const top = bytes[at + 2] | (bytes[at + 3] << 8);
    const frameWidth = bytes[at + 4] | (bytes[at + 5] << 8);
    const frameHeight = bytes[at + 6] | (bytes[at + 7] << 8);
    const flags = bytes[at + 8];
    at += 9;
    let palette = global;
    if (flags & 0x80) {
      const size = 3 * (1 << ((flags & 7) + 1));
      palette = bytes.subarray(at, at + size);
      at += size;
    }
    if (!palette || frameWidth * frameHeight > MAX_PIXELS) break;
    const minCodeSize = bytes[at++];
    if (!(minCodeSize >= 2 && minCodeSize <= 11)) break;
    frames.push({
      left,
      top,
      width: frameWidth,
      height: frameHeight,
      interlaced: (flags & 0x40) !== 0,
      palette,
      transparent,
      disposal,
      delay: delay <= FASTEST_DELAY_MS ? FAST_DELAY_MS : delay,
      minCodeSize,
      data: at,
    });
    at = skipSubBlocks(bytes, at);
    transparent = -1;
    disposal = 0;
    delay = 0;
  }
  return frames.length ? { bytes, width, height, frames, plays } : null;
}

/**
 * Decode a GIF's first frame, or null for bytes that are not a GIF. The
 * logical screen is the image; what the frame does not cover, and its
 * transparent colour, are transparent. Data that ends early leaves the rest
 * of the frame transparent rather than failing the image.
 */
export function decodeGif(bytes: Uint8Array): DecodedGif | null {
  const file = readGif(bytes);
  if (!file) return null;
  const canvas = new GifCanvas(file);
  return { width: file.width, height: file.height, data: canvas.at(0) };
}

/**
 * The logical screen a GIF's frames are drawn on, one after another. `at`
 * answers the screen as it is once a frame is drawn, which is the canvas
 * itself — the caller copies what it keeps, since the next `at` draws over
 * it.
 */
export class GifCanvas {
  private readonly _file: GifFile;
  private readonly _data: Uint8Array;
  /** The frame last drawn, -1 before the first. */
  private _index = -1;
  /** The screen before the frame last drawn, where its disposal puts it
   *  back (3). */
  private _saved: Uint8Array | null = null;

  constructor(file: GifFile) {
    this._file = file;
    this._data = new Uint8Array(file.width * file.height * 4);
  }

  /** The screen once frame `index` is drawn. */
  at(index: number): Uint8Array {
    if (index < this._index) {
      this._data.fill(0);
      this._index = -1;
    }
    while (this._index < index) this._step();
    return this._data;
  }

  private _step(): void {
    const { frames, width } = this._file;
    const data = this._data;
    const last = frames[this._index];
    if (last) {
      // what the frame before leaves of itself
      if (last.disposal === 2) {
        forRect(this._file, last, (o) => data.fill(0, o, o + 4));
      } else if (last.disposal === 3 && this._saved) {
        const saved = this._saved;
        forRect(this._file, last, (o) => data.set(saved.subarray(o, o + 4), o));
      }
    }
    this._index += 1;
    const frame = frames[this._index];
    this._saved = frame.disposal === 3 ? data.slice() : null;
    const { bytes } = this._file;
    const indices = lzw(
      bytes,
      frame.data,
      frame.minCodeSize,
      frame.width * frame.height,
    );
    const { palette, transparent } = frame;
    const height = this._file.height;
    for (let row = 0; row < frame.height; row += 1) {
      const y =
        frame.top + (frame.interlaced ? interlacedRow(row, frame.height) : row);
      if (y >= height) continue;
      for (let col = 0; col < frame.width; col += 1) {
        const x = frame.left + col;
        if (x >= width) continue;
        const index = indices[row * frame.width + col];
        if (index === transparent || index * 3 + 2 >= palette.length) continue;
        const o = (y * width + x) * 4;
        data[o] = palette[index * 3];
        data[o + 1] = palette[index * 3 + 1];
        data[o + 2] = palette[index * 3 + 2];
        data[o + 3] = 255;
      }
    }
  }
}

/** Each pixel's offset in the screen's RGBA that a frame's rectangle
 *  covers, clipped to the screen. */
function forRect(
  file: GifFile,
  frame: GifFrame,
  each: (offset: number) => void,
): void {
  const right = Math.min(file.width, frame.left + frame.width);
  const bottom = Math.min(file.height, frame.top + frame.height);
  for (let y = frame.top; y < bottom; y += 1) {
    for (let x = frame.left; x < right; x += 1) each((y * file.width + x) * 4);
  }
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Past a run of data sub-blocks: each a length byte and that many bytes,
 *  ended by an empty one. */
function skipSubBlocks(bytes: Uint8Array, at: number): number {
  while (at < bytes.length) {
    const size = bytes[at++];
    if (size === 0) break;
    at += size;
  }
  return at;
}

/** Which row of the frame an interlaced image's `n`th stored row is: every
 *  eighth from 0, every eighth from 4, every fourth from 2, every second
 *  from 1. */
function interlacedRow(n: number, height: number): number {
  const passes: [number, number][] = [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ];
  for (const [start, step] of passes) {
    const rows = Math.ceil(Math.max(0, height - start) / step);
    if (n < rows) return start + n * step;
    n -= rows;
  }
  return height;
}

/**
 * The colour indices of one frame, from its LZW data (GIF89a, Appendix F):
 * variable-width codes, least significant bit first, across data sub-blocks,
 * starting a code wider than the palette's and growing to twelve bits. A
 * frame whose data ends early has the rest of its indices 0, which the
 * caller never reaches past the pixels it has — they are left transparent
 * only when the frame said the colour 0 was.
 */
function lzw(
  bytes: Uint8Array,
  at: number,
  minCodeSize: number,
  pixels: number,
): Uint8Array {
  const out = new Uint8Array(pixels);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i += 1) suffix[i] = i;

  let size = minCodeSize + 1;
  let mask = (1 << size) - 1;
  let next = clear + 2;
  let previous = -1;
  let first = 0;
  let written = 0;

  // the bit reader, over the sub-blocks
  let block = 0;
  let bits = 0;
  let count = 0;

  while (written < pixels) {
    while (count < size) {
      if (block === 0) {
        if (at >= bytes.length) return out;
        block = bytes[at++];
        if (block === 0) return out;
      }
      if (at >= bytes.length) return out;
      bits |= bytes[at++] << count;
      count += 8;
      block -= 1;
    }
    let code = bits & mask;
    bits >>>= size;
    count -= size;

    if (code === clear) {
      size = minCodeSize + 1;
      mask = (1 << size) - 1;
      next = clear + 2;
      previous = -1;
      continue;
    }
    if (code === end) break;
    if (previous === -1) {
      if (code >= clear) break; // a first code that is no colour: corrupt
      out[written++] = code;
      previous = code;
      first = code;
      continue;
    }
    const incoming = code;
    let top = 0;
    if (code >= next) {
      // the code being defined by this very step: the previous string and
      // its own first character (the "KwKwK" case)
      if (code > next) break;
      stack[top++] = first;
      code = previous;
    }
    while (code >= clear) {
      stack[top++] = suffix[code];
      code = prefix[code];
    }
    first = code;
    stack[top++] = first;
    if (next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      next += 1;
      if ((next & mask) === 0 && next < 4096) {
        size += 1;
        mask = (1 << size) - 1;
      }
    }
    previous = incoming;
    while (top > 0 && written < pixels) out[written++] = stack[--top];
  }
  return out;
}
