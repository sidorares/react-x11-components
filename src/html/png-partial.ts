// A PNG that stops short, as a browser shows one: the pixels its data
// reached, with their final values, and the rest transparent (PNG 3, 13.10,
// "Progressive display").
//
// A browser decodes an image as its bytes arrive, so a file cut off in its
// image data still shows the rows, or for an Adam7-interlaced image the
// passes, it got to. Core's decoder ladder takes a whole file or none, and
// refuses one whose stream ends early, which drew nothing at all. So where
// it refuses a PNG, the image data is read here as far as it goes: inflated
// with a sync flush, which hands over what the stream holds so far, and
// unfiltered a scanline at a time until a line is short.
//
// This is a fallback and nothing else: a PNG core decodes never reaches it.

/** An inflater that hands over as much as a stream holds, ending or not. */
export type PartialInflate = (data: Uint8Array) => Uint8Array;

/** The most pixels a header may say it has: past this a malformed header is
 *  a request for gigabytes, not an image. */
const MAX_PIXELS = 1 << 25;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Adam7's passes: where each starts, and its steps across and down. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

const CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};

const u32 = (b: Uint8Array, at: number) =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** Whether bytes start as a PNG does. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

/**
 * A PNG's pixels as far as its image data goes, as straight RGBA: null for
 * bytes with no header to size it by, a header no PNG has, or a file that
 * reaches its `IEND`, which did not stop short.
 */
export function decodePartialPng(
  bytes: Uint8Array,
  inflate: PartialInflate,
): { width: number; height: number; data: Uint8Array } | null {
  if (!isPng(bytes) || bytes.length < 33) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  const depth = bytes[24];
  const type = bytes[25];
  const interlaced = bytes[28] === 1;
  const channels = CHANNELS[type];
  if (
    !width ||
    !height ||
    width * height > MAX_PIXELS ||
    !channels ||
    ![1, 2, 4, 8, 16].includes(depth)
  ) {
    return null;
  }
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const parts: Uint8Array[] = [];
  let size = 0;
  // the chunks, as far as they go; a chunk cut short is taken as far as it
  // is there, its CRC unread
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = u32(bytes, at);
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(
      at + 8,
      Math.min(bytes.length, at + 8 + length),
    );
    if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') {
      parts.push(data);
      size += data.length;
    } else if (name === 'IEND') {
      // a file that ends as a PNG ends is whole, and one a decoder refuses
      // whole is broken, which a browser draws as a failed image
      return null;
    }
    at += 12 + length;
  }
  const stream = new Uint8Array(size);
  let filled = 0;
  for (const part of parts) {
    stream.set(part, filled);
    filled += part.length;
  }
  let raw: Uint8Array;
  try {
    raw = size ? inflate(stream) : new Uint8Array(0);
  } catch {
    raw = new Uint8Array(0);
  }
  const out = new Uint8Array(width * height * 4);
  const bits = channels * depth;
  const step = Math.max(1, bits >> 3);
  const max = (1 << Math.min(depth, 8)) - 1;
  const sample = (line: Uint8Array, index: number): number => {
    if (depth === 8) return line[index];
    if (depth === 16) return (line[index * 2] << 8) | line[index * 2 + 1];
    const per = 8 / depth;
    const byte = line[Math.floor(index / per)];
    const shift = 8 - depth * ((index % per) + 1);
    return (byte >> shift) & max;
  };
  /** A sample at the bit depth, to 8 bits. */
  const to8 = (v: number): number =>
    depth === 16
      ? Math.round(v / 257)
      : depth === 8
        ? v
        : Math.round((v * 255) / max);
  const put = (line: Uint8Array, x: number, ox: number, oy: number): void => {
    const o = (oy * width + ox) * 4;
    const c = x * channels;
    if (type === 3) {
      const i = sample(line, c);
      if (!palette || i * 3 + 2 >= palette.length) return;
      out[o] = palette[i * 3];
      out[o + 1] = palette[i * 3 + 1];
      out[o + 2] = palette[i * 3 + 2];
      out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      return;
    }
    if (type === 0 || type === 4) {
      const g = sample(line, c);
      const v = to8(g);
      out[o] = out[o + 1] = out[o + 2] = v;
      if (type === 4) out[o + 3] = to8(sample(line, c + 1));
      else
        out[o + 3] =
          trns && trns.length >= 2 && g === ((trns[0] << 8) | trns[1])
            ? 0
            : 255;
      return;
    }
    const r = sample(line, c);
    const g = sample(line, c + 1);
    const b = sample(line, c + 2);
    out[o] = to8(r);
    out[o + 1] = to8(g);
    out[o + 2] = to8(b);
    if (type === 6) out[o + 3] = to8(sample(line, c + 3));
    else {
      out[o + 3] =
        trns &&
        trns.length >= 6 &&
        r === ((trns[0] << 8) | trns[1]) &&
        g === ((trns[2] << 8) | trns[3]) &&
        b === ((trns[4] << 8) | trns[5])
          ? 0
          : 255;
    }
  };
  let at = 0;
  const passes = interlaced ? ADAM7 : [[0, 0, 1, 1]];
  for (const [x0, y0, dx, dy] of passes) {
    const cols = Math.ceil((width - x0) / dx);
    const rows = Math.ceil((height - y0) / dy);
    if (cols <= 0 || rows <= 0) continue;
    const stride = Math.ceil((cols * bits) / 8);
    let prev = new Uint8Array(stride);
    for (let row = 0; row < rows; row += 1) {
      if (at + 1 + stride > raw.length) return { width, height, data: out };
      const filter = raw[at];
      const line = raw.slice(at + 1, at + 1 + stride);
      at += 1 + stride;
      if (!unfilter(filter, line, prev, step)) {
        return { width, height, data: out };
      }
      for (let x = 0; x < cols; x += 1)
        put(line, x, x0 + x * dx, y0 + row * dy);
      prev = line;
    }
  }
  return { width, height, data: out };
}

/** PNG's five filters undone on a scanline, in place: false for one no
 *  PNG has. */
function unfilter(
  filter: number,
  line: Uint8Array,
  prev: Uint8Array,
  step: number,
): boolean {
  const n = line.length;
  switch (filter) {
    case 0:
      return true;
    case 1:
      for (let i = step; i < n; i += 1)
        line[i] = (line[i] + line[i - step]) & 255;
      return true;
    case 2:
      for (let i = 0; i < n; i += 1) line[i] = (line[i] + prev[i]) & 255;
      return true;
    case 3:
      for (let i = 0; i < n; i += 1) {
        const left = i >= step ? line[i - step] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255;
      }
      return true;
    case 4:
      for (let i = 0; i < n; i += 1) {
        const a = i >= step ? line[i - step] : 0;
        const b = prev[i];
        const c = i >= step ? prev[i - step] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pred) & 255;
      }
      return true;
    default:
      return false;
  }
}
