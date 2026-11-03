// Fragmented MP4 written by hand, as YouTube's is, for the tests of what a
// page appends to a `MediaSource` of H.264 and AAC (`src/html/scripts/
// fmp4.ts`, `feeds.ts`): an initialization segment of one track — `avc1` with
// its `avcC`, or `mp4a` with its `esds` — with the edit list YouTube's video
// starts a frame in with, and media segments whose `tfhd` says the default
// duration and whose `trun` (version 0) says each sample's size, flags and
// composition offset. Nothing here is decoded; each sample's bytes are its
// own, so a test can tell them apart.

import {
  ascii,
  box,
  fullBox,
  MATRIX,
  u16,
  u32,
  zeros,
} from '../src/html/scripts/mp4.js';

export interface FixtureTrack {
  kind: 'video' | 'audio';
  timescale: number;
  width?: number;
  height?: number;
  /** The edit list's media time: what every time is taken back by. */
  shift?: number;
  /** H.264's level, which names the codec: `avc1.4d40<level>`. */
  level?: number;
  /** The stream's length in the movie's ticks, in `mehd`. */
  duration?: number;
}

function sampleEntry(track: FixtureTrack): Uint8Array {
  if (track.kind === 'video') {
    const sps = [0x67, 0x4d, 0x40, track.level ?? 0x1f, 0xaa];
    const pps = [0x68, 0xee, 0x3c, 0x80];
    return box(
      'avc1',
      zeros(6),
      u16(1),
      zeros(16),
      u16(track.width ?? 640),
      u16(track.height ?? 360),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      zeros(32),
      u16(0x18),
      u16(0xffff),
      box(
        'avcC',
        [1, 0x4d, 0x40, track.level ?? 0x1f, 0xff, 0xe1],
        u16(sps.length),
        sps,
        [1],
        u16(pps.length),
        pps,
      ),
    );
  }
  // ES_Descriptor > DecoderConfigDescriptor (AAC) > AudioSpecificConfig
  // 0x1210, AAC LC at 44.1 kHz in two channels, and an SLConfig
  const esds = fullBox(
    'esds',
    0,
    0,
    [0x03, 25, 0, 1, 0],
    [0x04, 17, 0x40, 0x15, 0, 0, 0],
    u32(0),
    u32(0),
    [0x05, 2, 0x12, 0x10],
    [0x06, 1, 2],
  );
  return box(
    'mp4a',
    zeros(6),
    u16(1),
    zeros(8),
    u16(2),
    u16(16),
    zeros(4),
    u32(track.timescale * 0x10000),
    esds,
  );
}

/** An initialization segment: `ftyp`, then a `moov` of one track, its id 1. */
export function fmp4Init(track: FixtureTrack): Uint8Array {
  const video = track.kind === 'video';
  return join([
    box('ftyp', ascii('dash'), u32(0), ascii('iso6'), ascii('mp41')),
    box(
      'moov',
      fullBox(
        'mvhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(track.timescale),
        u32(track.duration ?? 0),
        u32(0x00010000),
        u16(0x0100),
        zeros(10),
        MATRIX,
        zeros(24),
        u32(2),
      ),
      box(
        'mvex',
        ...(track.duration ? [fullBox('mehd', 0, 0, u32(track.duration))] : []),
        fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)),
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
          u32(0),
          zeros(8),
          u16(0),
          u16(0),
          u16(video ? 0 : 0x0100),
          u16(0),
          MATRIX,
          u32((track.width ?? 0) * 0x10000),
          u32((track.height ?? 0) * 0x10000),
        ),
        ...(track.shift
          ? [
              box(
                'edts',
                fullBox(
                  'elst',
                  0,
                  0,
                  u32(1),
                  u32(0),
                  u32(track.shift),
                  u32(0x00010000),
                ),
              ),
            ]
          : []),
        box(
          'mdia',
          fullBox(
            'mdhd',
            0,
            0,
            u32(0),
            u32(0),
            u32(track.timescale),
            u32(0),
            u16(0x55c4),
            u16(0),
          ),
          fullBox(
            'hdlr',
            0,
            0,
            u32(0),
            ascii(video ? 'vide' : 'soun'),
            zeros(12),
            [0],
          ),
          box(
            'minf',
            video
              ? fullBox('vmhd', 0, 1, zeros(8))
              : fullBox('smhd', 0, 0, zeros(4)),
            box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            box(
              'stbl',
              fullBox('stsd', 0, 0, u32(1), sampleEntry(track)),
              fullBox('stts', 0, 0, u32(0)),
              fullBox('stsc', 0, 0, u32(0)),
              fullBox('stsz', 0, 0, u32(0), u32(0)),
              fullBox('stco', 0, 0, u32(0)),
            ),
          ),
        ),
      ),
    ),
  ]);
}

/** A sample a segment holds, in its track's ticks. */
export interface FixtureSample {
  duration: number;
  cto?: number;
  sync: boolean;
  data: Uint8Array;
}

/**
 * A media segment of track 1, as YouTube's are: a `tfhd` with the default
 * duration where every sample lasts as long, a version-0 `trun` of sizes,
 * flags and composition offsets, and the `mdat`.
 */
export function fmp4Segment(
  sequence: number,
  decodeTime: number,
  samples: FixtureSample[],
): Uint8Array {
  const same = samples.every((s) => s.duration === samples[0].duration);
  const flags = 0x1 | 0x200 | 0x400 | 0x800 | (same ? 0 : 0x100);
  const entries = samples.flatMap((s) => [
    ...(same ? [] : u32(s.duration)),
    ...u32(s.data.length),
    ...u32(s.sync ? 0x02000000 : 0x01010000),
    ...u32(s.cto ?? 0),
  ]);
  const moof = (offset: number) =>
    box(
      'moof',
      fullBox('mfhd', 0, 0, u32(sequence)),
      box(
        'traf',
        fullBox(
          'tfhd',
          0,
          0x20002 | (same ? 0x8 : 0),
          u32(1),
          u32(1),
          ...(same ? [u32(samples[0].duration)] : []),
        ),
        fullBox('tfdt', 0, 0, u32(decodeTime)),
        fullBox('trun', 0, flags, u32(samples.length), u32(offset), entries),
      ),
    );
  const head = moof(moof(0).length + 8);
  const bytes = samples.reduce((n, s) => n + s.data.length, 0);
  return join([
    head,
    new Uint8Array([...u32(bytes + 8), ...ascii('mdat')]),
    ...samples.map((s) => s.data),
  ]);
}

/** A sample's bytes that say which it is: its track, its number and some
 *  more, so that two are never alike. */
export function sampleBytes(track: string, n: number, size = 24): Uint8Array {
  const out = new Uint8Array(size);
  out[0] = track.charCodeAt(0);
  out[1] = (n >> 16) & 0xff;
  out[2] = (n >> 8) & 0xff;
  out[3] = n & 0xff;
  for (let i = 4; i < size; i += 1) out[i] = (n * 31 + i * 7) & 0xff;
  return out;
}

/**
 * A video's frames from `first`: `count` of them, `frame` ticks each, a key
 * frame every `gop`, in decode order, each B-frame-like pair after a key
 * frame shown out of order as H.264's are, so that a presentation is its
 * decode plus a composition offset of one or two frames.
 */
export function videoSamples(
  first: number,
  count: number,
  frame: number,
  gop: number,
): FixtureSample[] {
  const out: FixtureSample[] = [];
  for (let i = 0; i < count; i += 1) {
    const n = first + i;
    const inGop = n % gop;
    // I P B B P B B …: a P shows two frames on, its B-frames one back
    const cto = inGop === 0 ? frame : inGop % 3 === 1 ? 3 * frame : 0;
    out.push({
      duration: frame,
      cto,
      sync: inGop === 0,
      data: sampleBytes('v', n, 24 + (n % 7)),
    });
  }
  return out;
}

/** An audio track's frames from `first`: `count` of `frame` ticks, every
 *  one of them a sync sample. */
export function audioSamples(
  first: number,
  count: number,
  frame: number,
): FixtureSample[] {
  return Array.from({ length: count }, (_, i) => ({
    duration: frame,
    sync: true,
    data: sampleBytes('a', first + i, 16),
  }));
}

export function join(pieces: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}
