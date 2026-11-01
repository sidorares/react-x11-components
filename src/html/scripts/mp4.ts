// VP9 packets as an MP4 file, for the platform's player to open.
//
// **The packets are not touched.** AVFoundation does not open WebM at all, and
// it does play the same VP9 in an MP4 (`vp09`, the VP Codec ISO Media File
// Format Binding), on the system's decoder. So what a page appended as WebM
// (`webm.ts`) is rewrapped: every sample here is the bytes of one block, and
// only the tables around them are new. Nothing is decoded or encoded, so a
// clip of megabytes takes a millisecond or so.
//
// The tables go before the samples, so a player needs none of the file's end
// to start: the layout `-movflags +faststart` makes. One track, one chunk,
// and a time scale fine enough that a block's millisecond rounds no sample
// onto its neighbour.

import type { WebmColour } from './webm.js';

/** What the file's tables are made from. */
export interface Mp4Video {
  width: number;
  height: number;
  colour: WebmColour;
  /** The whole length in seconds, where a stream said: a last sample lasts
   *  to it. */
  duration: number | null;
}

/** A sample: when it shows, in seconds, and its bytes. */
export interface Mp4Sample {
  time: number;
  data: Uint8Array;
}

/** A time scale every common frame rate lands on nearly exactly. */
const TIME_SCALE = 90_000;
/** What a last sample lasts where nothing says, in seconds. */
const ONE_FRAME = 1 / 30;

const ascii = (text: string): number[] =>
  Array.from(text, (c) => c.charCodeAt(0));
const u16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const zeros = (n: number): number[] => new Array<number>(n).fill(0);

/** A box: its size, its type, and what is in it. */
function box(type: string, ...parts: (number[] | Uint8Array)[]): Uint8Array {
  const size = parts.reduce((sum, p) => sum + p.length, 8);
  const out = new Uint8Array(size);
  out.set([...u32(size), ...ascii(type)]);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A box with a version and flags (`FullBox`). */
const fullBox = (
  type: string,
  version: number,
  flags: number,
  ...parts: (number[] | Uint8Array)[]
): Uint8Array => box(type, [version, ...u32(flags).slice(1)], ...parts);

const MATRIX = [
  ...u32(0x00010000),
  ...zeros(12),
  ...u32(0x00010000),
  ...zeros(12),
  ...u32(0x40000000),
];

/** What VP9's own header says of a stream (9.2, "Uncompressed header
 *  syntax"), from a key frame. */
export interface Vp9Config {
  profile: number;
  bitDepth: number;
  /** VP Codec binding's numbering: 1 for 4:2:0, 2 for 4:2:2, 3 for 4:4:4. */
  chroma: number;
  fullRange: boolean;
  /** ISO/IEC 23091's matrix coefficients for its `color_space`. */
  matrix: number;
}

/** Bits, most significant first. */
class Bits {
  private _at = 0;
  constructor(private readonly _data: Uint8Array) {}
  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = this._data[this._at >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (this._at & 7))) & 1);
      this._at += 1;
    }
    return value;
  }
}

/** `color_space` to ISO/IEC 23091's matrix coefficients: unknown, BT.601,
 *  BT.709, SMPTE 170M, SMPTE 240M, BT.2020, reserved, sRGB. */
const VP9_MATRICES = [2, 5, 1, 6, 7, 9, 2, 0];
const VP9_SRGB = 7;

/**
 * Whether a packet starts a key frame, and what its header says of the stream
 * where it does. A container's flag is no help: a Block in a BlockGroup has
 * none, and Apple's clips are written so.
 */
export function vp9Frame(data: Uint8Array): {
  key: boolean;
  config: Vp9Config | null;
} {
  const bits = new Bits(data);
  if (bits.read(2) !== 2) return { key: false, config: null };
  const low = bits.read(1);
  const profile = (bits.read(1) << 1) | low;
  if (profile === 3) bits.read(1);
  if (bits.read(1)) return { key: false, config: null };
  const key = bits.read(1) === 0;
  if (!key) return { key: false, config: null };
  bits.read(2);
  if (bits.read(24) !== 0x498342) return { key: false, config: null };
  const bitDepth = profile >= 2 ? (bits.read(1) ? 12 : 10) : 8;
  const colorSpace = bits.read(3);
  let fullRange = true;
  let chroma = 3;
  if (colorSpace !== VP9_SRGB) {
    fullRange = bits.read(1) === 1;
    chroma = 1;
    if (profile === 1 || profile === 3) {
      const x = bits.read(1);
      const y = bits.read(1);
      chroma = x && y ? 1 : x ? 2 : 3;
    }
  }
  return {
    key: true,
    config: {
      profile,
      bitDepth,
      chroma,
      fullRange,
      matrix: VP9_MATRICES[colorSpace],
    },
  };
}

/** The VP9 levels, as the binding numbers them: each with the most luma
 *  samples a second and in a picture it takes (Annex A). */
const LEVELS: [number, number, number][] = [
  [10, 829_440, 36_864],
  [11, 2_764_800, 73_728],
  [20, 4_608_000, 122_880],
  [21, 9_216_000, 245_760],
  [30, 20_736_000, 552_960],
  [31, 36_864_000, 983_040],
  [40, 83_558_400, 2_228_224],
  [41, 160_432_128, 2_228_224],
  [50, 311_951_360, 8_912_896],
  [51, 588_251_136, 8_912_896],
  [52, 1_176_502_272, 8_912_896],
  [60, 1_176_502_272, 35_651_584],
  [61, 2_353_004_544, 35_651_584],
  [62, 4_706_009_088, 35_651_584],
];

function levelFor(width: number, height: number, frameRate: number): number {
  const picture = width * height;
  const rate = picture * frameRate;
  for (const [level, samples, size] of LEVELS) {
    if (rate <= samples && picture <= size) return level;
  }
  return 62;
}

function vpcC(
  video: Mp4Video,
  config: Vp9Config | null,
  frameRate: number,
): Uint8Array {
  const { colour } = video;
  const full =
    colour.range !== undefined ? colour.range === 2 : !!config?.fullRange;
  const bitDepth = config?.bitDepth ?? 8;
  const chroma = config?.chroma ?? 1;
  return fullBox(
    'vpcC',
    1,
    0,
    [
      config?.profile ?? 0,
      levelFor(video.width, video.height, frameRate),
      (bitDepth << 4) | (chroma << 1) | (full ? 1 : 0),
      colour.primaries ?? 2,
      colour.transfer ?? 2,
      colour.matrix ?? config?.matrix ?? 2,
    ],
    u16(0),
  );
}

/** The track's run-length table of how long each sample lasts. */
function stts(lengths: number[]): Uint8Array {
  const runs: number[] = [];
  let count = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    count += 1;
    if (lengths[i + 1] === lengths[i]) continue;
    runs.push(...u32(count), ...u32(lengths[i]));
    count = 0;
  }
  return fullBox('stts', 0, 0, u32(runs.length / 8), runs);
}

/**
 * The file, as the pieces it is written in: the tables, then the samples
 * as they are. `samples` are in the order they show, and at least one.
 */
export function vp9Mp4(video: Mp4Video, samples: Mp4Sample[]): Uint8Array[] {
  const first = samples[0].time;
  const ticks = (seconds: number): number =>
    Math.round((seconds - first) * TIME_SCALE);
  const last = samples[samples.length - 1];
  const mean =
    samples.length > 1 ? (last.time - first) / (samples.length - 1) : ONE_FRAME;
  const end = Math.max(last.time + mean, video.duration ?? 0);
  const total = ticks(end);
  const lengths = samples.map((s, i) =>
    Math.max(
      1,
      (i + 1 < samples.length ? ticks(samples[i + 1].time) : total) -
        ticks(s.time),
    ),
  );
  const sizes = samples.map((s) => s.data.length);
  const mdatSize = sizes.reduce((a, b) => a + b, 8);
  let config: Vp9Config | null = null;
  const sync: number[] = [];
  samples.forEach((s, i) => {
    const frame = vp9Frame(s.data);
    if (!frame.key) return;
    config ??= frame.config;
    sync.push(...u32(i + 1));
  });

  const ftyp = box(
    'ftyp',
    ascii('isom'),
    u32(0x200),
    ascii('isom'),
    ascii('iso2'),
    ascii('mp41'),
  );
  const duration = Math.round(total);
  const sampleEntry = box(
    'vp09',
    zeros(6),
    u16(1),
    zeros(16),
    u16(video.width),
    u16(video.height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    zeros(32),
    u16(0x18),
    u16(0xffff),
    vpcC(video, config, samples.length / Math.max(end - first, ONE_FRAME)),
  );
  /** The tables, with the file offset of its samples. */
  const moov = (offset: number): Uint8Array =>
    box(
      'moov',
      fullBox(
        'mvhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(TIME_SCALE),
        u32(duration),
        u32(0x00010000),
        u16(0x0100),
        zeros(10),
        MATRIX,
        zeros(24),
        u32(2),
      ),
      box(
        'trak',
        fullBox(
          'tkhd',
          0,
          3,
          u32(0),
          u32(0),
          u32(1),
          u32(0),
          u32(duration),
          zeros(8),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          MATRIX,
          u32(video.width * 0x10000),
          u32(video.height * 0x10000),
        ),
        box(
          'mdia',
          fullBox(
            'mdhd',
            0,
            0,
            u32(0),
            u32(0),
            u32(TIME_SCALE),
            u32(duration),
            u16(0x55c4),
            u16(0),
          ),
          fullBox(
            'hdlr',
            0,
            0,
            u32(0),
            ascii('vide'),
            zeros(12),
            ascii('VideoHandler'),
            [0],
          ),
          box(
            'minf',
            fullBox('vmhd', 0, 1, zeros(8)),
            box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            box(
              'stbl',
              fullBox('stsd', 0, 0, u32(1), sampleEntry),
              stts(lengths),
              fullBox(
                'stsc',
                0,
                0,
                u32(1),
                u32(1),
                u32(samples.length),
                u32(1),
              ),
              fullBox(
                'stsz',
                0,
                0,
                u32(0),
                u32(samples.length),
                sizes.flatMap(u32),
              ),
              fullBox('stco', 0, 0, u32(1), u32(offset)),
              ...(sync.length
                ? [fullBox('stss', 0, 0, u32(sync.length / 4), sync)]
                : []),
            ),
          ),
        ),
      ),
    );
  // the tables are the same size whatever offset they name
  const tables = moov(ftyp.length + moov(0).length + 8);
  return [
    ftyp,
    tables,
    new Uint8Array([...u32(mdatSize), ...ascii('mdat')]),
    ...samples.map((s) => s.data),
  ];
}
