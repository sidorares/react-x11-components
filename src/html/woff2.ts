// WOFF2 → sfnt: the font inside the container the web serves one in.
//
// A WOFF2 is an OpenType font with its tables in one Brotli stream and its
// outlines written another way, and nearly every `@font-face` on the web
// names nothing else. A text engine that reads the container needs none of
// this, as ntk's does, through fontkit. CoreText reads an sfnt and nothing
// else, so react-x11's `loadFont` refuses a WOFF2 on macOS, and a page set
// in a web font was set in its fallback there: nextjs.org in Arial, for
// Geist. What an engine cannot read as served it is handed as the font the
// file holds (`WebFonts._register`), which is what this rebuilds.
//
// The format is W3C's (WOFF File Format 2.0): a header, a directory whose
// lengths are variable-width integers, then the stream. Three tables may be
// stored another way than an sfnt has them: `glyf` as seven streams —
// contour counts, point counts, flags, coordinates as triplets of one to
// four bytes, composites, the bounding boxes that are not their points',
// instructions — with `loca` left out, since an outline's offset is where
// it lands, and `hmtx` without the left side bearings that equal a glyph's
// `xMin`. Each is put back as the table an sfnt has (5.1, 5.3 and 5.4), and
// everything else is copied. What comes out is the font, not the file it was made from: the
// outlines are packed as the reference decoder packs them, which is the
// tightest a `glyf` allows and not necessarily what the font's author wrote.
//
// Brotli is the caller's (`inflate`), and `sfntFromWoff2` brings node's: its
// `zlib` has one, and nothing in `src/` names a node module, so it is
// reached the way `src/embed/host.ts` reaches `child_process`. A collection
// (`ttcf`), a file that ends early and anything else that does not read as
// the format come back as null, a source that did not load — and so does
// every file on a runtime with no Brotli to read one with.

const SIGNATURE = 0x774f4632; // 'wOF2'
const TTCF = 0x74746366;

/** The tags a directory entry names by number (4.1, "Known Table Tags"). */
const KNOWN_TAGS = (
  'cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ ' +
  'VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS ' +
  'GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix acnt avar bdat bloc ' +
  'bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop ' +
  'trak Zapf Silf Glat Gloc Feat Sill'
)
  .split(' ')
  .map((tag) => tag.replace('_', ' '));

/** Whether bytes are a WOFF2 file, by their signature. */
export function isWoff2(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x77 &&
    bytes[1] === 0x4f &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x32
  );
}

type Inflate = (data: Uint8Array) => Uint8Array;

/** More than any one font's tables come to: a CJK family's face is a
 *  quarter of it. */
const LARGEST_FONT = 1 << 26;

let brotli: Promise<Inflate | null> | null = null;

/** node's Brotli, or null where there is none. The specifier is a variable
 *  on purpose: a literal `import('node:zlib')` would need `@types/node` in
 *  the build program, and a bundler would try to resolve it. */
function nodeBrotli(): Promise<Inflate | null> {
  brotli ??= (async () => {
    try {
      const specifier = 'node:zlib';
      const zlib = (await import(/* @vite-ignore */ specifier)) as {
        brotliDecompressSync?(
          data: Uint8Array,
          options: { maxOutputLength: number },
        ): Uint8Array;
      };
      const inflate = zlib.brotliDecompressSync;
      // a few bytes of Brotli can stand for gigabytes, and the stream is a
      // page's: past the largest font there is, it is not one
      return typeof inflate === 'function'
        ? (data) => inflate(data, { maxOutputLength: LARGEST_FONT })
        : null;
    } catch {
      return null;
    }
  })();
  return brotli;
}

/** The sfnt a WOFF2 file holds (`woff2ToSfnt`), read with node's Brotli;
 *  null for a file that is not one, and where there is no Brotli. */
export async function sfntFromWoff2(
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  if (!isWoff2(bytes)) return null;
  const inflate = await nodeBrotli();
  return inflate ? woff2ToSfnt(bytes, inflate) : null;
}

/** A cursor over bytes, big-endian as an sfnt is. A read past the end
 *  throws, which is how a truncated file is found. */
class Reader {
  private _view: DataView;
  pos = 0;
  constructor(readonly bytes: Uint8Array) {
    this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number {
    return this._view.getUint8(this.pos++);
  }
  u16(): number {
    const v = this._view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this._view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this._view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  /** The next `length` bytes, as a view. */
  take(length: number): Uint8Array {
    if (length < 0 || this.pos + length > this.bytes.length) {
      throw new RangeError('woff2: a stream ends early');
    }
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
  /** `UIntBase128`: seven bits a byte, the high bit for "more" (3.1). */
  base128(): number {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = this.u8();
      if (i === 0 && byte === 0x80) break; // a leading zero
      if (value > 0x1ffffff) break; // would overflow 32 bits
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new RangeError('woff2: a length that is not a UIntBase128');
  }
  /** `255UInt16`: one to three bytes for a 16-bit number (3.1). */
  u255(): number {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 506;
    return code;
  }
}

/** Bytes being written, growing as they are. */
class Writer {
  bytes = new Uint8Array(1024);
  length = 0;
  private _room(more: number): void {
    if (this.length + more <= this.bytes.length) return;
    const grown = new Uint8Array(
      Math.max(this.bytes.length * 2, this.length + more),
    );
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }
  u8(v: number): void {
    this._room(1);
    this.bytes[this.length++] = v & 0xff;
  }
  u16(v: number): void {
    this._room(2);
    this.bytes[this.length++] = (v >> 8) & 0xff;
    this.bytes[this.length++] = v & 0xff;
  }
  put(data: Uint8Array): void {
    this._room(data.length);
    this.bytes.set(data, this.length);
    this.length += data.length;
  }
  /** Zeros up to a multiple of four, which a glyph and a table start on. */
  align(): void {
    const pad = (4 - (this.length & 3)) & 3;
    this._room(pad);
    this.bytes.fill(0, this.length, this.length + pad);
    this.length += pad;
  }
  done(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

interface Entry {
  tag: string;
  /** Stored another way than an sfnt has it, and to be put back. */
  transformed: boolean;
  /** Its length in the stream. */
  length: number;
  data: Uint8Array;
}

// `glyf` flags (OpenType, "Simple Glyph Description")
const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME = 0x10; // or, with X_SHORT, "positive"
const Y_SAME = 0x20;
const OVERLAP_SIMPLE = 0x40;

// composite glyph flags
const ARG_WORDS = 0x0001;
const HAVE_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const HAVE_XY_SCALE = 0x0040;
const HAVE_TWO_BY_TWO = 0x0080;
const HAVE_INSTRUCTIONS = 0x0100;

interface Outlines {
  glyf: Uint8Array;
  loca: Uint8Array;
  /** Whether `loca` holds 32-bit offsets, which `head` has to agree on. */
  long: boolean;
  /** Each glyph's `xMin`: the side bearing a transformed `hmtx` left out. */
  xMins: Int16Array;
}

/**
 * `glyf` and `loca` from a transformed `glyf` (5.1): each glyph's record
 * written as an sfnt has it, and the offsets they landed at.
 */
function outlines(data: Uint8Array): Outlines {
  const head = new Reader(data);
  head.u16(); // reserved
  const options = head.u16();
  const numGlyphs = head.u16();
  const indexFormat = head.u16();
  const sizes = [0, 0, 0, 0, 0, 0, 0].map(() => head.u32());
  const [contours, points, flags, glyphs, composites, boxes, instructions] =
    sizes.map((size) => new Reader(head.take(size)));
  const overlaps =
    options & 1 ? head.take((numGlyphs + 7) >> 3) : new Uint8Array(0);
  // the boxes that are written out, a bit a glyph, then the boxes
  const explicit = boxes.take(((numGlyphs + 31) >> 5) << 2);
  const bit = (map: Uint8Array, i: number): boolean =>
    i >> 3 < map.length && (map[i >> 3] & (0x80 >> (i & 7))) !== 0;

  const out = new Writer();
  const offsets = new Uint32Array(numGlyphs + 1);
  const xMins = new Int16Array(numGlyphs);
  const xs: number[] = [];
  const ys: number[] = [];
  const on: boolean[] = [];
  const moves = new Writer();
  const rises = new Writer();
  for (let g = 0; g < numGlyphs; g += 1) {
    offsets[g] = out.length;
    const count = contours.i16();
    if (count === 0) continue; // no outline, and no record
    if (count < 0) {
      // a composite: its components as they are, and a box always written
      if (!bit(explicit, g)) throw new RangeError('woff2: a composite, no box');
      const box = boxes.take(8);
      const from = composites.pos;
      let more = true;
      let instructed = false;
      while (more) {
        const flag = composites.u16();
        composites.pos += 2; // the component's glyph
        composites.pos += flag & ARG_WORDS ? 4 : 2;
        if (flag & HAVE_SCALE) composites.pos += 2;
        else if (flag & HAVE_XY_SCALE) composites.pos += 4;
        else if (flag & HAVE_TWO_BY_TWO) composites.pos += 8;
        if (flag & HAVE_INSTRUCTIONS) instructed = true;
        more = (flag & MORE_COMPONENTS) !== 0;
      }
      const to = composites.pos;
      composites.pos = from;
      out.u16(0xffff);
      out.put(box);
      out.put(composites.take(to - from));
      if (instructed) {
        const length = glyphs.u255();
        out.u16(length);
        out.put(instructions.take(length));
      }
      xMins[g] = (box[0] << 8) | box[1];
      out.align();
      continue;
    }

    // a simple glyph: where each contour ends, then its points as the
    // moves between them
    const ends: number[] = [];
    let total = 0;
    for (let c = 0; c < count; c += 1) {
      total += points.u255();
      ends.push(total - 1);
    }
    xs.length = ys.length = on.length = total;
    let x = 0;
    let y = 0;
    let xMin = 0;
    let yMin = 0;
    let xMax = 0;
    let yMax = 0;
    for (let p = 0; p < total; p += 1) {
      // a triplet: a flag that says how many bytes the move is in, which
      // way each half of it goes and whether the point is on the curve
      // (5.2, table "Triplet Encoding")
      const flag = flags.u8();
      const f = flag & 0x7f;
      let dx: number;
      let dy: number;
      if (f < 10) {
        dx = 0;
        dy = ((f & 14) << 7) + glyphs.u8();
        if (!(f & 1)) dy = -dy;
      } else if (f < 20) {
        dx = (((f - 10) & 14) << 7) + glyphs.u8();
        dy = 0;
        if (!(f & 1)) dx = -dx;
      } else if (f < 84) {
        const b0 = f - 20;
        const b1 = glyphs.u8();
        dx = 1 + (b0 & 0x30) + (b1 >> 4);
        dy = 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f);
        if (!(f & 1)) dx = -dx;
        if (!(f & 2)) dy = -dy;
      } else if (f < 120) {
        const b0 = f - 84;
        dx = 1 + (Math.floor(b0 / 12) << 8) + glyphs.u8();
        dy = 1 + (((b0 % 12) >> 2) << 8) + glyphs.u8();
        if (!(f & 1)) dx = -dx;
        if (!(f & 2)) dy = -dy;
      } else if (f < 124) {
        const b0 = glyphs.u8();
        const b1 = glyphs.u8();
        const b2 = glyphs.u8();
        dx = (b0 << 4) + (b1 >> 4);
        dy = ((b1 & 0x0f) << 8) + b2;
        if (!(f & 1)) dx = -dx;
        if (!(f & 2)) dy = -dy;
      } else {
        dx = glyphs.u16();
        dy = glyphs.u16();
        if (!(f & 1)) dx = -dx;
        if (!(f & 2)) dy = -dy;
      }
      x += dx;
      y += dy;
      xs[p] = x;
      ys[p] = y;
      on[p] = !(flag & 0x80);
      if (p === 0) {
        xMin = xMax = x;
        yMin = yMax = y;
      } else {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    const length = glyphs.u255();

    out.u16(count);
    if (bit(explicit, g)) {
      const box = boxes.take(8);
      out.put(box);
      xMin = (box[0] << 8) | box[1];
    } else {
      // the box of its points, which is what an encoder leaves out
      out.u16(xMin);
      out.u16(yMin);
      out.u16(xMax);
      out.u16(yMax);
    }
    xMins[g] = xMin;
    for (const end of ends) out.u16(end);
    out.u16(length);
    out.put(instructions.take(length));

    // The flags, a run of equal ones written once with a count, then the
    // horizontal moves and the vertical ones: a byte where a move fits
    // one, nothing where there is none.
    moves.length = rises.length = 0;
    let last = -1;
    let repeats = 0;
    let px = 0;
    let py = 0;
    for (let p = 0; p < total; p += 1) {
      let flag = on[p] ? ON_CURVE : 0;
      if (p === 0 && bit(overlaps, g)) flag |= OVERLAP_SIMPLE;
      const dx = xs[p] - px;
      const dy = ys[p] - py;
      if (dx === 0) flag |= X_SAME;
      else if (dx > -256 && dx < 256) {
        flag |= X_SHORT | (dx > 0 ? X_SAME : 0);
        moves.u8(Math.abs(dx));
      } else moves.u16(dx);
      if (dy === 0) flag |= Y_SAME;
      else if (dy > -256 && dy < 256) {
        flag |= Y_SHORT | (dy > 0 ? Y_SAME : 0);
        rises.u8(Math.abs(dy));
      } else rises.u16(dy);
      if (flag === last && repeats !== 255) {
        out.bytes[out.length - 1] |= REPEAT;
        repeats += 1;
      } else {
        if (repeats) out.u8(repeats);
        out.u8(flag);
        repeats = 0;
      }
      last = flag;
      px = xs[p];
      py = ys[p];
    }
    if (repeats) out.u8(repeats);
    out.put(moves.done());
    out.put(rises.done());
    out.align();
  }
  offsets[numGlyphs] = out.length;

  // `loca` in the width the font asked for, or the wider one where the
  // outlines, packed again, no longer fit it
  const long = indexFormat !== 0 || out.length > 0x1fffe;
  const loca = new Uint8Array((numGlyphs + 1) * (long ? 4 : 2));
  const view = new DataView(loca.buffer);
  for (let g = 0; g <= numGlyphs; g += 1) {
    if (long) view.setUint32(g * 4, offsets[g]);
    else view.setUint16(g * 2, offsets[g] >> 1);
  }
  return { glyf: out.done(), loca, long, xMins };
}

/**
 * `hmtx` from a transformed one (5.4): the advances as they were, and each
 * side bearing the encoder left out put back as its glyph's `xMin`, which
 * is what it left them out for equalling.
 */
function metrics(
  data: Uint8Array,
  numGlyphs: number,
  numHMetrics: number,
  xMins: Int16Array,
): Uint8Array {
  const from = new Reader(data);
  const flags = from.u8();
  const advances: number[] = [];
  for (let i = 0; i < numHMetrics; i += 1) advances.push(from.u16());
  const out = new Writer();
  const bearings: number[] = [];
  for (let i = 0; i < numHMetrics; i += 1) {
    bearings.push(flags & 1 ? (xMins[i] ?? 0) : from.i16());
  }
  for (let i = numHMetrics; i < numGlyphs; i += 1) {
    bearings.push(flags & 2 ? (xMins[i] ?? 0) : from.i16());
  }
  for (let i = 0; i < numGlyphs; i += 1) {
    if (i < numHMetrics) out.u16(advances[i]);
    out.u16(bearings[i]);
  }
  return out.done();
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  const whole = data.length & ~3;
  for (let i = 0; i < whole; i += 4) {
    sum =
      (sum +
        ((data[i] << 24) |
          (data[i + 1] << 16) |
          (data[i + 2] << 8) |
          data[i + 3])) >>>
      0;
  }
  if (whole < data.length) {
    let last = 0;
    for (let i = whole; i < data.length; i += 1) {
      last |= data[i] << (24 - 8 * (i - whole));
    }
    sum = (sum + last) >>> 0;
  }
  return sum;
}

/**
 * The sfnt — TrueType or OpenType — a WOFF2 file holds, or null when the
 * bytes are not one this reads. `inflate` is Brotli: the compressed stream
 * in, its bytes out.
 */
export function woff2ToSfnt(
  bytes: Uint8Array,
  inflate: Inflate,
): Uint8Array | null {
  try {
    return rebuild(bytes, inflate);
  } catch {
    // truncated, or not the format: a source that did not load
    return null;
  }
}

function rebuild(bytes: Uint8Array, inflate: Inflate): Uint8Array | null {
  const file = new Reader(bytes);
  if (file.u32() !== SIGNATURE) return null;
  const flavor = file.u32();
  // a collection shares tables between its fonts, and a face is one font
  if (flavor === TTCF) return null;
  file.u32(); // length
  const numTables = file.u16();
  file.u16(); // reserved
  file.u32(); // totalSfntSize
  const compressed = file.u32();
  file.pos = 48;

  const entries: Entry[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const flags = file.u8();
    const known = flags & 0x3f;
    const tag =
      known === 0x3f ? String.fromCharCode(...file.take(4)) : KNOWN_TAGS[known];
    const version = flags >> 6;
    const original = file.base128();
    // `glyf` and `loca` are transformed at version 0 and plain at 3; every
    // other table is plain at 0 (4.1, the flags' transformation version)
    const transformed =
      tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? file.base128() : original;
    entries.push({ tag, transformed, length, data: bytes });
  }
  if (new Set(entries.map((e) => e.tag)).size !== entries.length) return null;

  const stream = new Reader(inflate(file.take(compressed)));
  for (const entry of entries) entry.data = stream.take(entry.length);

  const tables = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (!entry.transformed) tables.set(entry.tag, entry.data);
  }
  const glyf = entries.find((e) => e.tag === 'glyf');
  const loca = entries.find((e) => e.tag === 'loca');
  let made: Outlines | null = null;
  if (glyf?.transformed) {
    // the two are transformed together, and `loca` is then no bytes at all
    if (!loca?.transformed || loca.length !== 0) return null;
    made = outlines(glyf.data);
    tables.set('glyf', made.glyf);
    tables.set('loca', made.loca);
  } else if (loca?.transformed) return null;

  const hmtx = entries.find((e) => e.tag === 'hmtx');
  if (hmtx?.transformed) {
    const hhea = tables.get('hhea');
    const maxp = tables.get('maxp');
    if (!made || !hhea || !maxp) return null;
    const numHMetrics = new Reader(hhea.subarray(34)).u16();
    const numGlyphs = new Reader(maxp.subarray(4)).u16();
    tables.set('hmtx', metrics(hmtx.data, numGlyphs, numHMetrics, made.xMins));
  }
  for (const entry of entries) {
    // any other transform is one this format has not defined
    if (entry.transformed && !tables.has(entry.tag)) return null;
  }

  const head = tables.get('head');
  if (head && head.length >= 54) {
    // `head` is written again: its checksum of the whole file is this
    // file's, and its `loca` width is the one the offsets were written in
    const copy = head.slice();
    copy.fill(0, 8, 12);
    if (made) copy[51] = made.long ? 1 : 0;
    tables.set('head', copy);
  }

  // The sfnt: a header, a directory in tag order, then each table on a
  // four-byte boundary (OpenType, "Organization of an OpenType Font").
  const tags = [...tables.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const count = tags.length;
  let size = 12 + 16 * count;
  for (const tag of tags) size += (tables.get(tag)!.length + 3) & ~3;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const log = Math.floor(Math.log2(count || 1));
  view.setUint32(0, flavor);
  view.setUint16(4, count);
  view.setUint16(6, 16 << log);
  view.setUint16(8, log);
  view.setUint16(10, 16 * count - (16 << log));
  let at = 12 + 16 * count;
  let headAt = -1;
  tags.forEach((tag, i) => {
    const data = tables.get(tag)!;
    const record = 12 + 16 * i;
    for (let c = 0; c < 4; c += 1) out[record + c] = tag.charCodeAt(c);
    view.setUint32(record + 4, checksum(data));
    view.setUint32(record + 8, at);
    view.setUint32(record + 12, data.length);
    out.set(data, at);
    if (tag === 'head') headAt = at;
    at += (data.length + 3) & ~3;
  });
  if (headAt >= 0 && tables.get('head')!.length >= 12) {
    view.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  }
  return out;
}
