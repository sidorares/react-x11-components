// What a page's peer connections encode and decode their media with: VP8,
// VP9 and Opus through libav.js's `webm-vp9` build — FFmpeg's libavcodec
// with libvpx and libopus, compiled to WebAssembly — and G.711, which is a
// table, here. The werift adapter's media pipeline (`./werift-media.ts`)
// reads frames from a page's sources, encodes them with this and hands the
// packets to werift's RTP sender, and decodes what werift's receiver hands
// it back into a receiver's frames.
//
// libav.js is an optional peer, as werift is: some 19 megabytes installed,
// which an app that sends no media over a connection never wants, so it is
// never installed for anyone. It is reached by a dynamic `import()` whose
// specifier the compiler cannot see, the first time media must flow, and its
// types are written out here, structurally, so an app without it
// type-checks. Not installed, a connection still connects and negotiates
// its codecs, and sends and receives no Opus, VP8 or VP9: a receiver's track
// stays muted, as one whose peer sends nothing does. G.711 needs none of it.
//
// What a peer sends is parsed in WebAssembly, never in native code
// (docs/prd-webrtc.md, "Threat model"). One instance of libav.js serves
// every codec of the process, its calls one after another (`serial`): it is
// one WebAssembly memory, and each call runs to its end on the thread that
// made it. That thread is the page's, today: VP8 at 640×480 takes some 4 ms
// a frame to encode and 1 ms to decode, and Opus a tenth of a millisecond a
// packet, which a page that sends a call can afford and a page with several
// tracks at a larger size cannot. A worker for the codecs is the next step
// (docs/prd-webrtc.md, "A codec's thread"); the interface here is
// asynchronous so that moving them changes no caller.

import { toI420 } from './media-devices.js';
import type { MediaVideoFrame } from './media-devices.js';

// --- libav.js's shape, the slice read here ----------------------------------

/** A frame as libav.js hands it over and takes it: one array of bytes laid
 *  out by `layout` for video, an array or one array a channel for audio. */
interface LibAVFrame {
  data: unknown;
  format: number;
  layout?: { offset: number; stride: number }[];
  pts?: number;
  width?: number;
  height?: number;
  key_frame?: number;
  pict_type?: number;
  nb_samples?: number;
  channels?: number;
  channel_layout?: number;
  sample_rate?: number;
}

interface LibAVPacket {
  data: Uint8Array;
  pts?: number;
  flags?: number;
}

interface LibAVInstance {
  readonly AV_PIX_FMT_YUV420P: number;
  readonly AV_SAMPLE_FMT_FLT: number;
  readonly AV_SAMPLE_FMT_FLTP: number;
  readonly AV_LOG_QUIET?: number;
  av_log_set_level?(level: number): Promise<void>;
  ff_init_encoder(
    name: string,
    opts: {
      ctx: Record<string, number>;
      time_base: [number, number];
      options?: Record<string, string>;
    },
  ): Promise<[number, number, number, number, number]>;
  ff_init_decoder(
    name: string,
    config?: { codecpar?: Record<string, number> },
  ): Promise<[number, number, number, number]>;
  ff_encode_multi(
    ctx: number,
    frame: number,
    pkt: number,
    frames: LibAVFrame[],
    fin?: boolean,
  ): Promise<LibAVPacket[]>;
  ff_decode_multi(
    ctx: number,
    pkt: number,
    frame: number,
    packets: LibAVPacket[],
    config?: { fin?: boolean; ignoreErrors?: boolean },
  ): Promise<LibAVFrame[]>;
  ff_free_encoder(ctx: number, frame: number, pkt: number): Promise<void>;
  ff_free_decoder(ctx: number, pkt: number, frame: number): Promise<void>;
}

interface LibAVWrapper {
  LibAV(opts: {
    noworker: boolean;
    nothreads: boolean;
  }): Promise<LibAVInstance>;
}

/** Where libav.js is found: a variable, so no bundler follows it. */
const LIBAV_MODULE = '@libav.js/variant-webm-vp9';

let loading: Promise<LibAVInstance | null> | null = null;

/** libav.js's `webm-vp9` build, where it is installed, or null. */
export function loadLibAV(): Promise<LibAVInstance | null> {
  if (!loading) {
    const specifier = LIBAV_MODULE;
    loading = (
      import(/* @vite-ignore */ specifier) as Promise<{
        default?: LibAVWrapper;
        LibAV?: LibAVWrapper['LibAV'];
      }>
    )
      .then(async (m) => {
        const wrapper = (m?.default ?? m) as LibAVWrapper;
        if (typeof wrapper?.LibAV !== 'function') return null;
        const libav = await wrapper.LibAV({ noworker: true, nothreads: true });
        // it logs each codec's version to stderr as it opens one
        await libav.av_log_set_level?.(libav.AV_LOG_QUIET ?? -8);
        return libav;
      })
      .catch(() => null);
  }
  return loading;
}

/** What libav.js does one call at a time: one WebAssembly memory. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

// --- what the pipeline asks for ---------------------------------------------

/** A video codec this encodes and decodes, as werift names it. */
export type VideoCodecName = 'VP8' | 'VP9';
/** An audio codec this encodes and decodes, as werift names it. */
export type AudioCodecName = 'OPUS' | 'PCMU' | 'PCMA';

/** One encoded frame. */
export interface EncodedFrame {
  data: Uint8Array;
  key: boolean;
}

export interface VideoEncoderLike {
  /** Encodes one frame, a key frame where `key` asks for one, at a time on
   *  a 90 kHz clock: what it came to, nothing where the codec held it. */
  encode(
    frame: MediaVideoFrame,
    key: boolean,
    time: number,
  ): Promise<EncodedFrame[]>;
  close(): void;
}

export interface VideoDecoderLike {
  /** Decodes one frame's bytes: the pictures it came to, I420. */
  decode(data: Uint8Array): Promise<MediaVideoFrame[]>;
  close(): void;
}

export interface AudioEncoderLike {
  /** The rate it takes samples at, and how many make a packet. */
  readonly sampleRate: number;
  readonly frameSize: number;
  /** Encodes one packet's samples, mono, `frameSize` of them. */
  encode(samples: Float32Array): Promise<Uint8Array[]>;
  close(): void;
}

export interface AudioDecoderLike {
  readonly sampleRate: number;
  /** Decodes one packet: its samples, one array a channel. */
  decode(data: Uint8Array): Promise<Float32Array[] | null>;
  close(): void;
}

/** The codec of a werift `mimeType` this handles, or null. */
export function videoCodecOf(mimeType: string): VideoCodecName | null {
  const name = mimeType.split('/')[1]?.toUpperCase();
  return name === 'VP8' || name === 'VP9' ? name : null;
}
export function audioCodecOf(mimeType: string): AudioCodecName | null {
  const name = mimeType.split('/')[1]?.toUpperCase();
  return name === 'OPUS' || name === 'PCMU' || name === 'PCMA' ? name : null;
}

/** Whether a codec needs libav.js: G.711 does not. */
export const needsLibAV = (codec: VideoCodecName | AudioCodecName): boolean =>
  codec !== 'PCMU' && codec !== 'PCMA';

// --- video ------------------------------------------------------------------

/** What libvpx is told for a call: realtime, no frames held back, and a key
 *  frame only where one is asked for (a decoder that lost one asks). */
const VPX_OPTIONS: Record<string, string> = {
  deadline: 'realtime',
  'cpu-used': '8',
  'lag-in-frames': '0',
  'error-resilient': '1',
};

/** A bit rate for a size: about Chrome's start for a call, which it then
 *  adapts; nothing here adapts. */
const bitRateFor = (width: number, height: number): number =>
  Math.max(150_000, Math.min(2_500_000, Math.round(width * height * 3)));

/** An I420 frame as one array libav.js takes, with the layout it reads. */
function packed(frame: MediaVideoFrame): LibAVFrame & { data: Uint8Array } {
  const f = toI420(frame);
  const [y, cb, cr] = f.planes;
  const [sy, sc, sr] = f.strides;
  const ch = (f.height + 1) >> 1;
  const sizes = [sy * f.height, sc * ch, sr * ch];
  const data = new Uint8Array(sizes[0] + sizes[1] + sizes[2]);
  data.set(y.subarray(0, sizes[0]), 0);
  data.set(cb.subarray(0, sizes[1]), sizes[0]);
  data.set(cr.subarray(0, sizes[2]), sizes[0] + sizes[1]);
  return {
    data,
    format: 0,
    width: f.width,
    height: f.height,
    layout: [
      { offset: 0, stride: sy },
      { offset: sizes[0], stride: sc },
      { offset: sizes[0] + sizes[1], stride: sr },
    ],
  };
}

class LibAVVideoEncoder implements VideoEncoderLike {
  private _open: Promise<[number, number, number] | null> | null = null;
  private _size = '';
  private _closed = false;

  constructor(
    private readonly _libav: LibAVInstance,
    private readonly _codec: VideoCodecName,
  ) {}

  private _ready(width: number, height: number) {
    const size = `${width}x${height}`;
    if (this._open && this._size === size) return this._open;
    this._release();
    this._size = size;
    const libav = this._libav;
    this._open = serial(async () => {
      const [, c, frame, pkt] = await libav.ff_init_encoder(
        this._codec === 'VP8' ? 'libvpx' : 'libvpx-vp9',
        {
          ctx: {
            width,
            height,
            pix_fmt: libav.AV_PIX_FMT_YUV420P,
            bit_rate: bitRateFor(width, height),
            gop_size: 1 << 30,
            keyint_min: 1 << 30,
          },
          time_base: [1, 90000],
          options: VPX_OPTIONS,
        },
      );
      return [c, frame, pkt] as [number, number, number];
    }).catch(() => null);
    return this._open;
  }

  async encode(
    frame: MediaVideoFrame,
    key: boolean,
    time: number,
  ): Promise<EncodedFrame[]> {
    if (this._closed) return [];
    const input = packed(frame);
    const open = await this._ready(input.width!, input.height!);
    if (!open || this._closed) return [];
    const [c, f, p] = open;
    input.pts = time;
    if (key) {
      input.key_frame = 1;
      input.pict_type = 1;
    }
    const packets = await serial(() =>
      this._libav.ff_encode_multi(c, f, p, [input]),
    );
    return packets.map((packet) => ({
      data: packet.data,
      key: ((packet.flags ?? 0) & 1) === 1,
    }));
  }

  private _release(): void {
    const open = this._open;
    this._open = null;
    void open?.then((o) => {
      if (o) void serial(() => this._libav.ff_free_encoder(o[0], o[1], o[2]));
    });
  }

  close(): void {
    this._closed = true;
    this._release();
  }
}

class LibAVVideoDecoder implements VideoDecoderLike {
  private readonly _open: Promise<[number, number, number] | null>;
  private _closed = false;

  constructor(
    private readonly _libav: LibAVInstance,
    codec: VideoCodecName,
  ) {
    this._open = serial(async () => {
      const [, c, pkt, frame] = await _libav.ff_init_decoder(
        codec === 'VP8' ? 'libvpx' : 'libvpx-vp9',
      );
      return [c, pkt, frame] as [number, number, number];
    }).catch(() => null);
  }

  async decode(data: Uint8Array): Promise<MediaVideoFrame[]> {
    const open = await this._open;
    if (!open || this._closed) return [];
    const [c, p, f] = open;
    let frames: LibAVFrame[];
    try {
      frames = await serial(() =>
        this._libav.ff_decode_multi(c, p, f, [{ data }], {
          ignoreErrors: true,
        }),
      );
    } catch {
      return [];
    }
    const out: MediaVideoFrame[] = [];
    for (const frame of frames) {
      const bytes = frame.data as Uint8Array;
      const layout = frame.layout;
      const width = frame.width ?? 0;
      const height = frame.height ?? 0;
      if (!(bytes instanceof Uint8Array) || !layout || layout.length < 3) {
        continue;
      }
      if (frame.format !== this._libav.AV_PIX_FMT_YUV420P) continue;
      const ch = (height + 1) >> 1;
      const plane = (i: number, rows: number) =>
        bytes.subarray(
          layout[i].offset,
          layout[i].offset + layout[i].stride * rows,
        );
      out.push({
        format: 'I420',
        width,
        height,
        planes: [plane(0, height), plane(1, ch), plane(2, ch)],
        strides: [layout[0].stride, layout[1].stride, layout[2].stride],
        timestamp: 0,
      });
    }
    return out;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    void this._open.then((o) => {
      if (o) void serial(() => this._libav.ff_free_decoder(o[0], o[1], o[2]));
    });
  }
}

// --- audio ------------------------------------------------------------------

/** Opus as a call sends it: 48 kHz, 20 ms a packet, one channel. */
class OpusEncoder implements AudioEncoderLike {
  readonly sampleRate = 48000;
  readonly frameSize = 960;
  private readonly _open: Promise<[number, number, number] | null>;
  private _closed = false;
  private _pts = 0;

  constructor(private readonly _libav: LibAVInstance) {
    this._open = serial(async () => {
      const [, c, frame, pkt] = await _libav.ff_init_encoder('libopus', {
        ctx: {
          sample_rate: 48000,
          channel_layout: 4,
          channels: 1,
          sample_fmt: _libav.AV_SAMPLE_FMT_FLT,
          bit_rate: 32000,
        },
        time_base: [1, 48000],
        options: { application: 'voip' },
      });
      return [c, frame, pkt] as [number, number, number];
    }).catch(() => null);
  }

  async encode(samples: Float32Array): Promise<Uint8Array[]> {
    const open = await this._open;
    if (!open || this._closed) return [];
    const [c, f, p] = open;
    const pts = this._pts;
    this._pts += samples.length;
    const packets = await serial(() =>
      this._libav.ff_encode_multi(c, f, p, [
        {
          data: samples,
          format: this._libav.AV_SAMPLE_FMT_FLT,
          channel_layout: 4,
          channels: 1,
          sample_rate: 48000,
          nb_samples: samples.length,
          pts,
        },
      ]),
    );
    return packets.map((packet) => packet.data);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    void this._open.then((o) => {
      if (o) void serial(() => this._libav.ff_free_encoder(o[0], o[1], o[2]));
    });
  }
}

class OpusDecoder implements AudioDecoderLike {
  readonly sampleRate = 48000;
  private readonly _open: Promise<[number, number, number] | null>;
  private _closed = false;

  constructor(private readonly _libav: LibAVInstance) {
    this._open = serial(async () => {
      const [, c, pkt, frame] = await _libav.ff_init_decoder('libopus');
      return [c, pkt, frame] as [number, number, number];
    }).catch(() => null);
  }

  async decode(data: Uint8Array): Promise<Float32Array[] | null> {
    const open = await this._open;
    if (!open || this._closed) return null;
    const [c, p, f] = open;
    let frames: LibAVFrame[];
    try {
      frames = await serial(() =>
        this._libav.ff_decode_multi(c, p, f, [{ data }], {
          ignoreErrors: true,
        }),
      );
    } catch {
      return null;
    }
    const channels: Float32Array[][] = [];
    for (const frame of frames) {
      const n = frame.nb_samples ?? 0;
      const count = frame.channels ?? 1;
      if (Array.isArray(frame.data)) {
        (frame.data as Float32Array[]).forEach((plane, i) => {
          (channels[i] ??= []).push(plane.subarray(0, n));
        });
      } else if (frame.data instanceof Float32Array) {
        // interleaved
        const all = frame.data;
        for (let ch = 0; ch < count; ch++) {
          const plane = new Float32Array(n);
          for (let i = 0; i < n; i++) plane[i] = all[i * count + ch];
          (channels[ch] ??= []).push(plane);
        }
      }
    }
    if (!channels.length) return null;
    return channels.map((parts) => {
      if (parts.length === 1) return parts[0];
      const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    });
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    void this._open.then((o) => {
      if (o) void serial(() => this._libav.ff_free_decoder(o[0], o[1], o[2]));
    });
  }
}

/** G.711 (ITU-T G.711), µ-law and A-law: 8 kHz, a byte a sample, 20 ms a
 *  packet. A table each way, and nothing loaded for it. */
function linearToMu(sample: number): number {
  const BIAS = 0x84;
  let s = Math.max(-32635, Math.min(32635, Math.round(sample * 32767)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
function muToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const s = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return (sign ? -s : s) / 32768;
}
function linearToA(sample: number): number {
  let s = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
  const sign = s >= 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  let out: number;
  if (s < 256) out = s >> 4;
  else {
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 1; mask >>= 1) {
      exponent--;
    }
    out = (exponent << 4) | ((s >> (exponent + 3)) & 0x0f);
  }
  return (out | sign) ^ 0x55;
}
function aToLinear(byte: number): number {
  const a = byte ^ 0x55;
  const sign = a & 0x80;
  const exponent = (a >> 4) & 0x07;
  const mantissa = a & 0x0f;
  let s =
    exponent === 0
      ? (mantissa << 4) + 8
      : ((mantissa << 4) + 0x108) << (exponent - 1);
  if (!sign) s = -s;
  return s / 32768;
}

class G711Encoder implements AudioEncoderLike {
  readonly sampleRate = 8000;
  readonly frameSize = 160;
  constructor(private readonly _mu: boolean) {}
  encode(samples: Float32Array): Promise<Uint8Array[]> {
    const out = new Uint8Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = this._mu ? linearToMu(samples[i]) : linearToA(samples[i]);
    }
    return Promise.resolve([out]);
  }
  close(): void {}
}

class G711Decoder implements AudioDecoderLike {
  readonly sampleRate = 8000;
  constructor(private readonly _mu: boolean) {}
  decode(data: Uint8Array): Promise<Float32Array[] | null> {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      out[i] = this._mu ? muToLinear(data[i]) : aToLinear(data[i]);
    }
    return Promise.resolve([out]);
  }
  close(): void {}
}

// --- what the pipeline is handed --------------------------------------------

/** Each kind's codecs, made where they can be: null for one libav.js, not
 *  installed, would have made. */
export async function videoEncoder(
  codec: VideoCodecName,
): Promise<VideoEncoderLike | null> {
  const libav = await loadLibAV();
  return libav ? new LibAVVideoEncoder(libav, codec) : null;
}
export async function videoDecoder(
  codec: VideoCodecName,
): Promise<VideoDecoderLike | null> {
  const libav = await loadLibAV();
  return libav ? new LibAVVideoDecoder(libav, codec) : null;
}
export async function audioEncoder(
  codec: AudioCodecName,
): Promise<AudioEncoderLike | null> {
  if (codec === 'PCMU' || codec === 'PCMA') {
    return new G711Encoder(codec === 'PCMU');
  }
  const libav = await loadLibAV();
  return libav ? new OpusEncoder(libav) : null;
}
export async function audioDecoder(
  codec: AudioCodecName,
): Promise<AudioDecoderLike | null> {
  if (codec === 'PCMU' || codec === 'PCMA') {
    return new G711Decoder(codec === 'PCMU');
  }
  const libav = await loadLibAV();
  return libav ? new OpusDecoder(libav) : null;
}

/**
 * Samples at one rate made samples at another, linearly, a chunk at a time:
 * where a chunk ends between two output samples is carried to the next. A
 * call's audio is speech at a codec's rate, and nobody hears this yet
 * (docs/prd-webrtc.md, "Audio"), so a filter would buy nothing.
 */
export class Resampler {
  /** Where the next output sample falls, in input samples from this chunk's
   *  first: from -1, the last chunk's last sample, on. */
  private _pos = 0;
  private _last = 0;

  constructor(
    readonly from: number,
    readonly to: number,
  ) {}

  push(input: Float32Array): Float32Array {
    if (this.from === this.to) return input;
    const n = input.length;
    const step = this.from / this.to;
    const out: number[] = [];
    let p = this._pos;
    while (p <= n - 1) {
      const i = Math.floor(p);
      const a = i < 0 ? this._last : input[i];
      const b = i + 1 < n ? input[i + 1] : a;
      out.push(a + (b - a) * (p - i));
      p += step;
    }
    this._pos = p - n;
    if (n) this._last = input[n - 1];
    return Float32Array.from(out);
  }
}
