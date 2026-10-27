// A canvas's bitmap as a PNG file: what HTML's "serialization of a bitmap
// as a file" comes to for `toDataURL`, `toBlob` and an `OffscreenCanvas`'s
// `convertToBlob` (`encodeImage` in `host.ts`), and the one type a page
// asks for that is always had. The bitmap is straight RGBA, as a canvas
// reads it out, and so is the file: colour type 6, eight bits a channel.
//
// Each row takes the filter whose bytes come to the least, as libpng
// chooses (PNG 3, 12.8), and node's zlib deflates them: the facade holds
// no compressor, and a canvas's flat fills come to a few hundred bytes
// where stored blocks would be its whole bitmap again.
import { nodeModule } from './platform.js';

interface ZlibModule {
  deflateSync(data: Uint8Array, options?: { level?: number }): Uint8Array;
}

const { deflateSync } = await nodeModule<ZlibModule>('zlib');

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, from: number, to: number): number {
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
  for (let i = from; i < to; i += 1) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Each row, its filter byte first, filtered by whichever of none, sub, up
 *  and Paeth leaves the least sum of bytes read as signed. */
function filtered(width: number, height: number, rgba: Uint8Array) {
  const stride = width * 4;
  const out = new Uint8Array((stride + 1) * height);
  const trial = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const above = row - stride;
    let bestCost = Infinity;
    for (const filter of [0, 1, 2, 4]) {
      let cost = 0;
      for (let i = 0; i < stride; i += 1) {
        const x = rgba[row + i];
        const a = i >= 4 ? rgba[row + i - 4] : 0;
        const b = y > 0 ? rgba[above + i] : 0;
        let v: number;
        if (filter === 0) v = x;
        else if (filter === 1) v = x - a;
        else if (filter === 2) v = x - b;
        else {
          const c = y > 0 && i >= 4 ? rgba[above + i - 4] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        v &= 0xff;
        trial[i] = v;
        cost += v < 128 ? v : 256 - v;
        if (cost >= bestCost) break;
      }
      // a trial that came to more stopped early; one that came to less
      // ran the row through, and is written whole
      if (cost < bestCost) {
        bestCost = cost;
        out[y * (stride + 1)] = filter;
        out.set(trial, y * (stride + 1) + 1);
      }
    }
  }
  return out;
}

/** A PNG of a straight RGBA bitmap `width` by `height`. */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const idat = deflateSync(filtered(width, height, rgba), { level: 6 });
  const chunks: [string, Uint8Array][] = [
    ['IHDR', ihdr],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ];
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i += 1) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(
      at + 8 + data.length,
      crc32(out, at + 4, at + 8 + data.length),
    );
    at += 12 + data.length;
  }
  return out;
}
