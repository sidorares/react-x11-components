// A GIF's first frame, as RGBA.
//
// ntk decodes PNG and JPEG, and a document handed to this component is
// still full of GIFs: a mail's logo and its spacer images, a table layout's
// one-pixel shims sized by `width` and `height`. An image that does not
// decode is drawn as a frame, which on a spacer is a line through the
// layout that the author meant to be nothing. So the format is read here:
// GIF89a (and 87a) is small, fixed and unambiguous, and the decoder is the
// LZW variant the format defines, nothing more.
//
// Only the first frame. An animation is drawn as it stands before it moves,
// which is what a paused animation shows; playing one would mean a timer per
// image and a repaint per frame, which is not this renderer's business.

/** A decoded frame: straight RGBA, `width * height * 4` bytes — the shape
 *  ntk's `Image` is constructed from. */
export interface DecodedGif {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The most pixels a GIF may say it has: past this a malformed header is a
 *  request for gigabytes, not an image. */
const MAX_PIXELS = 1 << 25;

/**
 * Decode a GIF's first frame, or null for bytes that are not a GIF. The
 * logical screen is the image; what the frame does not cover, and its
 * transparent colour, are transparent. Data that ends early leaves the rest
 * of the frame transparent rather than failing the image.
 */
export function decodeGif(bytes: Uint8Array): DecodedGif | null {
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
  const data = new Uint8Array(width * height * 4);
  let transparent = -1;

  while (at < bytes.length) {
    const block = bytes[at++];
    if (block === 0x3b) break; // the trailer
    if (block === 0x21) {
      // an extension: a Graphic Control one says which colour is not drawn
      const label = bytes[at++];
      if (label === 0xf9 && bytes[at] >= 4) {
        const flags = bytes[at + 1];
        transparent = flags & 1 ? bytes[at + 4] : -1;
      }
      at = skipSubBlocks(bytes, at);
      continue;
    }
    if (block !== 0x2c) return null; // neither: not a GIF this can read
    if (at + 9 > bytes.length) return null;
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
    if (!palette || frameWidth * frameHeight > MAX_PIXELS) return null;
    const minCodeSize = bytes[at++];
    if (minCodeSize < 2 || minCodeSize > 11) return null;
    const indices = lzw(bytes, at, minCodeSize, frameWidth * frameHeight);
    const interlaced = (flags & 0x40) !== 0;
    for (let row = 0; row < frameHeight; row += 1) {
      const y = top + (interlaced ? interlacedRow(row, frameHeight) : row);
      if (y >= height) continue;
      for (let col = 0; col < frameWidth; col += 1) {
        const x = left + col;
        if (x >= width) continue;
        const index = indices[row * frameWidth + col];
        if (index === transparent || index * 3 + 2 >= palette.length) continue;
        const o = (y * width + x) * 4;
        data[o] = palette[index * 3];
        data[o + 1] = palette[index * 3 + 1];
        data[o + 2] = palette[index * 3 + 2];
        data[o + 3] = 255;
      }
    }
    return { width, height, data };
  }
  return null;
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
