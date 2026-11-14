// A BMP, as RGBA.
//
// Every browser shows a Windows bitmap, and core's decoder ladder reads one
// only under Bun: under Node an `<img>` of one failed. WPT's
// `common/security-features` answers every `<img>` it is asked for with a
// BMP of the request's headers, which a test reads back through a canvas,
// so all of `referrer-policy/`'s and `mixed-content/`'s image tests stood on
// it. The format is fixed and small, so it is read here, as a GIF is
// (`gif.ts`): the core and the info headers and their later versions, 1, 4,
// 8, 16, 24 and 32 bits a pixel, a palette, bit fields, rows either way up.
// What it does not read is RLE, which no page sends and every decoder a
// browser has warns of: such a file is no BMP here, a failed image.

/** A decoded bitmap: straight RGBA, `width * height * 4` bytes, the shape
 *  ntk's `Image` is constructed from. */
export interface DecodedBmp {
  width: number;
  height: number;
  data: Uint8Array;
}

/** What a BMP's headers say of its size, or null for none: what lays an
 *  `<img>` out before its pixels are in (`image-header.ts`). */
export function bmpSize(
  b: Uint8Array,
): { width: number; height: number } | null {
  const head = readHead(b);
  return head ? { width: head.width, height: head.height } : null;
}

interface Head {
  width: number;
  height: number;
  /** Rows from the top, where the height was negative. */
  topDown: boolean;
  bits: number;
  compression: number;
  /** Where the pixels start. */
  offset: number;
  /** Where the palette starts, and how big an entry is. */
  palette: number;
  entry: number;
  colours: number;
  masks: [number, number, number, number] | null;
}

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const i32 = (b: Uint8Array, at: number): number => u32(b, at) | 0;

/** The largest a side may be: what a hostile header cannot make allocate
 *  more than any image a page shows. */
const MAX_SIDE = 1 << 15;

function readHead(b: Uint8Array): Head | null {
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const offset = u32(b, 10);
  const size = u32(b, 14);
  let width: number;
  let height: number;
  let bits: number;
  let compression = 0;
  let colours = 0;
  let entry = 4;
  if (size === 12) {
    // BITMAPCOREHEADER: sides of 16 bits, a palette of three bytes an entry
    width = u16(b, 18);
    height = u16(b, 20);
    bits = u16(b, 24);
    entry = 3;
  } else if (size >= 40 && b.length >= 14 + 40) {
    width = i32(b, 18);
    height = i32(b, 22);
    bits = u16(b, 28);
    compression = u32(b, 30);
    colours = u32(b, 46);
  } else return null;
  const topDown = height < 0;
  height = Math.abs(height);
  if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE) {
    return null;
  }
  // bit fields: in the header from its fourth version, after it in the
  // first, where `BI_BITFIELDS` (3) or `BI_ALPHABITFIELDS` (6) says so
  let masks: Head['masks'] = null;
  let palette = 14 + size;
  if (compression === 3 || compression === 6) {
    if (size >= 52) {
      masks = [u32(b, 54), u32(b, 58), u32(b, 62), size >= 56 ? u32(b, 66) : 0];
    } else {
      const n = compression === 6 ? 4 : 3;
      if (b.length < palette + n * 4) return null;
      masks = [
        u32(b, palette),
        u32(b, palette + 4),
        u32(b, palette + 8),
        n === 4 ? u32(b, palette + 12) : 0,
      ];
      palette += n * 4;
    }
  } else if (compression !== 0) {
    // RLE, JPEG or PNG inside: read by no decoder here
    return null;
  }
  if (![1, 4, 8, 16, 24, 32].includes(bits)) return null;
  if (bits <= 8) colours = colours || 1 << bits;
  return {
    width,
    height,
    topDown,
    bits,
    compression,
    offset,
    palette,
    entry,
    colours,
    masks,
  };
}

/** A mask's shift and the scale that takes its value to 0 to 255. */
function field(mask: number): { shift: number; max: number } {
  if (!mask) return { shift: 0, max: 0 };
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  return { shift, max: mask >>> shift };
}

/**
 * The pixels of a BMP, or null where the bytes are none, or are of a kind
 * read by no decoder here, or are cut short. A 32-bit one is opaque unless
 * its fields name an alpha channel, as browsers read one, and a palette of
 * fewer entries than its indices reach is black past its end.
 */
export function decodeBmp(b: Uint8Array): DecodedBmp | null {
  const head = readHead(b);
  if (!head) return null;
  const { width, height, bits } = head;
  const stride = ((bits * width + 31) >>> 5) * 4;
  if (
    head.offset + stride * (height - 1) + Math.ceil((bits * width) / 8) >
    b.length
  ) {
    return null;
  }
  const data = new Uint8Array(width * height * 4);
  const masks =
    head.masks ??
    (bits === 16
      ? [0x7c00, 0x03e0, 0x001f, 0]
      : bits === 32
        ? [0xff0000, 0xff00, 0xff, 0]
        : null);
  const fields = masks?.map(field);
  for (let row = 0; row < height; row += 1) {
    const y = head.topDown ? row : height - 1 - row;
    const at = head.offset + row * stride;
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      if (bits <= 8) {
        const per = 8 / bits;
        const byte = b[at + Math.floor(x / per)];
        const index =
          (byte >>> (8 - bits - (x % per) * bits)) & ((1 << bits) - 1);
        const p = head.palette + index * head.entry;
        if (index < head.colours && p + 2 < b.length) {
          data[out] = b[p + 2];
          data[out + 1] = b[p + 1];
          data[out + 2] = b[p];
        }
        data[out + 3] = 255;
      } else if (bits === 24) {
        const p = at + x * 3;
        data[out] = b[p + 2];
        data[out + 1] = b[p + 1];
        data[out + 2] = b[p];
        data[out + 3] = 255;
      } else {
        const value = bits === 16 ? u16(b, at + x * 2) : u32(b, at + x * 4);
        for (let c = 0; c < 4; c += 1) {
          const { shift, max } = fields![c];
          data[out + c] = max
            ? Math.round((((value >>> shift) & max) * 255) / max)
            : c === 3
              ? 255
              : 0;
        }
      }
    }
  }
  return { width, height, data };
}
