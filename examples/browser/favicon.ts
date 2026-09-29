// A page's icon, for its tab.
//
// Which one: the `<link rel="icon">` a page names — the size nearest the
// 32 pixels a tab's 16 are drawn with on a 2x display, SVG and PNG before
// the rest — then an `apple-touch-icon`, then `/favicon.ico` at the site's
// root, which is where browsers have looked since before anyone named one.
//
// What it is: PNG and JPEG go to core's `<image>` as they came, and an SVG
// to its `<svg>`. An `.ico` is a directory of images, each a PNG or a
// Windows bitmap; the entry nearest 32 pixels is taken, a PNG as it is and a
// bitmap decoded here to the RGBA `<image>` also takes — nothing else in
// this stack reads BMP, and the format is a header, a palette and two
// bitmaps, one of which is the transparency.
import * as DomUtils from 'domutils';

import type { Document, Element } from '../../src/html/index.js';

/** An icon, as the tab draws it. `key` names the content, for `<image
 *  cacheKey>`. */
export type TabIcon =
  | { kind: 'image'; key: string; src: Uint8Array | RawImage }
  | { kind: 'svg'; key: string; source: string };

interface RawImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Where to look for a page's icon, best first. */
export function iconCandidates(doc: Document, pageUrl: string): string[] {
  let base = pageUrl;
  const baseElement = DomUtils.findOne(
    (el) => el.name === 'base' && !!el.attribs.href,
    doc.children,
  );
  if (baseElement) base = resolve(baseElement.attribs.href, pageUrl) ?? base;

  const scored: { url: string; score: number }[] = [];
  const links = DomUtils.findAll((el) => el.name === 'link', doc.children);
  for (const link of links) {
    const rel = (link.attribs.rel ?? '').toLowerCase().split(/\s+/);
    const href = link.attribs.href;
    if (!href) continue;
    let score: number;
    if (rel.includes('icon')) score = 0;
    else if (rel.includes('apple-touch-icon')) score = 2000;
    else continue;
    const url = resolve(href, base);
    if (!url) continue;
    score += sizeScore(link) + typeScore(link, url);
    scored.push({ url, score });
  }
  scored.sort((a, b) => a.score - b.score);
  const out = scored.map((s) => s.url);
  try {
    const page = new URL(pageUrl);
    if (page.protocol === 'http:' || page.protocol === 'https:') {
      out.push(`${page.origin}/favicon.ico`);
    }
  } catch {
    // no origin to look at the root of
  }
  return [...new Set(out)];
}

function resolve(href: string, base: string): string | null {
  try {
    return new URL(href.trim(), base).href;
  } catch {
    return null;
  }
}

/** How far a link's declared sizes are from 32 pixels; `any` (an SVG) is
 *  as good as it gets, and a link that says nothing is a guess. */
function sizeScore(link: Element): number {
  const sizes = (link.attribs.sizes ?? '').toLowerCase();
  if (sizes.includes('any')) return 0;
  let best = Infinity;
  for (const m of sizes.matchAll(/(\d+)x(\d+)/g)) {
    const size = Number(m[1]);
    // smaller than wanted is blurrier than larger is
    best = Math.min(best, size >= 32 ? size - 32 : (32 - size) * 4);
  }
  return best === Infinity ? 40 : best;
}

function typeScore(link: Element, url: string): number {
  const type = (link.attribs.type ?? '').toLowerCase();
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (type.includes('svg') || path.endsWith('.svg')) return 0;
  if (type.includes('png') || path.endsWith('.png')) return 1;
  if (type.includes('icon') || path.endsWith('.ico')) return 5;
  // WebP and the rest: nothing here decodes them
  if (type.includes('webp') || path.endsWith('.webp')) return 5000;
  return 10;
}

/** An icon's bytes as something a tab can draw, or null for a format
 *  nothing here reads. */
export function decodeIcon(bytes: Uint8Array, key: string): TabIcon | null {
  if (isPng(bytes) || isJpeg(bytes)) return { kind: 'image', key, src: bytes };
  const ico = decodeIco(bytes);
  if (ico) return { kind: 'image', key, src: ico };
  const text = new TextDecoder().decode(bytes.subarray(0, 4096));
  if (/<svg[\s>]/i.test(text)) {
    return { kind: 'svg', key, source: new TextDecoder().decode(bytes) };
  }
  return null;
}

const isPng = (b: Uint8Array) =>
  b.length > 8 &&
  b[0] === 0x89 &&
  b[1] === 0x50 &&
  b[2] === 0x4e &&
  b[3] === 0x47;
const isJpeg = (b: Uint8Array) =>
  b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const i32 = (b: Uint8Array, at: number) =>
  b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24);

/** The entry of an `.ico` nearest 32 pixels, the deepest colour among
 *  equals: its PNG, or its bitmap decoded. */
function decodeIco(b: Uint8Array): Uint8Array | RawImage | null {
  if (b.length < 6 || u16(b, 0) !== 0 || (u16(b, 2) !== 1 && u16(b, 2) !== 2)) {
    return null;
  }
  const count = u16(b, 4);
  let best: { width: number; offset: number; size: number } | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < count; i += 1) {
    const o = 6 + i * 16;
    if (o + 16 > b.length) break;
    const width = b[o] || 256;
    const bits = u16(b, o + 6);
    const size = u32(b, o + 8);
    const offset = u32(b, o + 12);
    if (!size || offset + size > b.length) continue;
    const score = Math.abs(width - 32) * 64 - bits;
    if (score < bestScore) {
      best = { width, offset, size };
      bestScore = score;
    }
  }
  if (!best) return null;
  const data = b.subarray(best.offset, best.offset + best.size);
  return isPng(data) ? data : decodeBitmap(data);
}

/**
 * A Windows bitmap as an icon stores one: a BITMAPINFOHEADER with the
 * height doubled, a palette below 16 bits, the colour bitmap bottom row
 * first, then a 1-bit mask where a set bit is transparent. A 32-bit bitmap
 * carries its own alpha — unless every alpha is zero, which old icons are,
 * and then the mask says.
 */
function decodeBitmap(d: Uint8Array): RawImage | null {
  if (d.length < 40) return null;
  const header = u32(d, 0);
  const width = i32(d, 4);
  const fullHeight = i32(d, 8);
  const bpp = u16(d, 14);
  const compression = u32(d, 16);
  const height = Math.abs(fullHeight) >> 1;
  if (width <= 0 || height <= 0 || width > 512 || height > 512) return null;
  if (compression !== 0 && compression !== 3) return null;
  if (![1, 4, 8, 24, 32].includes(bpp)) return null;
  let at = header;
  // BI_BITFIELDS puts its three masks after a 40-byte header
  if (compression === 3 && header === 40) at += 12;
  let palette: Uint8Array | null = null;
  if (bpp <= 8) {
    const colours = u32(d, 32) || 1 << bpp;
    palette = d.subarray(at, at + colours * 4);
    at += colours * 4;
  }
  const rowBytes = ((width * bpp + 31) >> 5) << 2;
  const pixels = d.subarray(at, at + rowBytes * height);
  at += rowBytes * height;
  const maskBytes = ((width + 31) >> 5) << 2;
  const mask = d.subarray(at, at + maskBytes * height);
  const bottomUp = fullHeight > 0;

  const out = new Uint8Array(width * height * 4);
  let alpha = false;
  for (let y = 0; y < height; y += 1) {
    const row = (bottomUp ? height - 1 - y : y) * rowBytes;
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let bl = 0;
      let a = 255;
      if (bpp === 32 || bpp === 24) {
        const p = row + x * (bpp >> 3);
        bl = pixels[p];
        g = pixels[p + 1];
        r = pixels[p + 2];
        if (bpp === 32) {
          a = pixels[p + 3];
          if (a) alpha = true;
        }
      } else if (palette) {
        const bit = x * bpp;
        const byte = pixels[row + (bit >> 3)] ?? 0;
        const index = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        bl = palette[index * 4] ?? 0;
        g = palette[index * 4 + 1] ?? 0;
        r = palette[index * 4 + 2] ?? 0;
      }
      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = bl;
      out[o + 3] = a;
    }
  }
  if (bpp < 32 || !alpha) {
    for (let y = 0; y < height; y += 1) {
      const row = (bottomUp ? height - 1 - y : y) * maskBytes;
      for (let x = 0; x < width; x += 1) {
        const hidden = ((mask[row + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        out[(y * width + x) * 4 + 3] = hidden ? 0 : 255;
      }
    }
  }
  return { width, height, data: out };
}
