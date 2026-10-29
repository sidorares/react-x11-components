// An image's size, read from the head of its file before it is decoded.
//
// A browser lays an image out at its size as soon as the bytes that say it
// are in, and decodes the pixels after (HTML 4.8.4.3, an image request is
// "partially available" once its width and height are known). The store
// waits for its pixels on a worker thread, or behind a decoder still
// loading, and an `<img>` that only its image sizes sat at the size of no
// image meanwhile, with everything below it laid out a picture's height too
// high: on Apple's MacBook Pro page, for two and a half seconds. So the
// store asks this first (`ResourceStore._decoding`), and the decode, when it
// lands, only has to bring the pixels.
//
// What is read is what the decoders read, and nothing more: a few bytes at
// fixed offsets, or a JPEG's segments walked by their lengths up to its
// frame header. A size this says that the decoder disagrees with is not an
// error: the decoded one wins, and the boxes laid out from this are built
// again. A module of its own, with nothing imported, so that all of it is
// asserted with no display.

/** A raster's size, in its pixels. */
export interface HeaderSize {
  width: number;
  height: number;
}

/**
 * The size an image's header says, or null where the bytes are no format
 * read here or are cut short of the size: PNG's IHDR, a JPEG's frame header
 * (SOF0 to SOF15), WebP's VP8, VP8L or VP8X chunk, GIF's logical screen.
 *
 * `orientation` is the EXIF Orientation of a JPEG, 1 to 8, as the decoder
 * reads it: one that turns a quarter (5 to 8) swaps the two sides, since
 * the decoder turns the pixels by it (ntk's `decodeImage`, as a browser's
 * `image-orientation: from-image`). Without it a JPEG is the size it is
 * stored at.
 */
export function headerSize(
  bytes: Uint8Array,
  orientation?: (bytes: Uint8Array) => number,
): HeaderSize | null {
  const size =
    pngSize(bytes) ??
    jpegSize(bytes, orientation) ??
    webpSize(bytes) ??
    gifSize(bytes);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

const u16be = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number): number =>
  b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number): number =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** The signature, then IHDR, which the format puts first. */
function pngSize(b: Uint8Array): HeaderSize | null {
  if (b.length < 24 || b[0] !== 0x89 || !ascii(b, 1, 'PNG\r\n\x1a\n')) {
    return null;
  }
  if (!ascii(b, 12, 'IHDR')) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/**
 * A JPEG's frame header: SOF0 to SOF15, which are C0 to CF but for C4
 * (DHT), C8 (JPG) and CC (DAC). Every segment before the first scan is
 * walked by its length, the 0xFF fill bytes a marker may follow skipped,
 * and the frame header always comes before the scan. A height of 0 is one a
 * DNL segment after the scan gives, and is not read here.
 */
function jpegSize(
  b: Uint8Array,
  orientation?: (bytes: Uint8Array) => number,
): HeaderSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let at = 2; at + 4 <= b.length;) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // markers with no length: TEM, the restarts, SOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // the scan, or the end of the image, with no frame before it
    if (marker === 0xda || marker === 0xd9) return null;
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      // length, precision, then the height and the width
      if (at + 9 > b.length) return null;
      const height = u16be(b, at + 5);
      const width = u16be(b, at + 7);
      const turned = (orientation?.(b) ?? 1) >= 5;
      return turned ? { width: height, height: width } : { width, height };
    }
    at += 2 + length;
  }
  return null;
}

/**
 * A WebP's first chunk: a lossy VP8 frame's dimensions after its start
 * code, a lossless VP8L's packed after its signature, or an extended
 * file's canvas in VP8X — what an animation's frames are drawn on, and so
 * the size its decoder gives a still one too.
 */
function webpSize(b: Uint8Array): HeaderSize | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) {
    return null;
  }
  if (ascii(b, 12, 'VP8 ')) {
    // a frame tag, three bytes, then the start code
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    // fourteen bits each; the two above them are an upscaling no decoder
    // here applies
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    // fourteen bits of the width less one, then fourteen of the height
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X')) {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

/** GIF's logical screen, which every frame is drawn on (`gif.ts`). */
function gifSize(b: Uint8Array): HeaderSize | null {
  if (b.length < 10 || !(ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) {
    return null;
  }
  return { width: u16le(b, 6), height: u16le(b, 8) };
}
