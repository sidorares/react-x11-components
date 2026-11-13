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
// made it. That thread is a worker of its own (`./media-codec-thread.ts`,
// "the codecs' thread" below), which holds the codecs by number: VP8 at
// 640×480 is some 4 to 8 ms a frame to encode, and a canvas's frame 2 ms
// more to make I420 of, which on the page's thread came out of every frame
// the page lays out, paints and runs its scripts in. What the page's thread
// does for a frame now is copy it once and post the copy, a third of a
// millisecond. Where no worker can be made — no `worker_threads`, or a
// bundle that left the entry behind — the codecs run on the page's thread,
// as they did, behind the same asynchronous interfaces (`VideoEncoderLike`
// and its kin), so where they run changes no caller.

import { toI420 } from './media-devices.js';
import type { MediaVideoFrame } from './media-devices.js';
import { nodeModule, threadEntry } from './scripts/platform.js';
import type { WorkerLike, WorkerThreadsModule } from './scripts/platform.js';

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
  side_data?: { type: number; data: Uint8Array }[] | null;
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
  /** The frame's PSNR in decibels, plane by plane, as the encoder measured
   *  what it reconstructs against what it was handed: where it measured. */
  psnr?: { y: number; u: number; v: number };
  /** The quantizer it was coded with, in the codec's own scale. */
  qp?: number;
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
  // each packet carries the squared error of each plane
  // (`AV_PKT_DATA_QUALITY_STATS`), which a sender's stats read their PSNR
  // from; libvpx works it out as it reconstructs the frame anyway
  flags: '+psnr',
};

/** FFmpeg's `AV_PKT_DATA_QUALITY_STATS`, and what its quality is a
 *  quantizer times (`FF_QP2LAMBDA`). */
const QUALITY_STATS = 8;
const QP2LAMBDA = 118;

/**
 * What a packet's quality stats say of the frame in it: a 32-bit quality,
 * which is the quantizer times `QP2LAMBDA`, the picture type, how many
 * errors follow, two bytes of nothing, then each plane's sum of squared
 * errors as a 64-bit integer, from which its PSNR is worked out.
 */
export function qualityOf(
  packet: Pick<LibAVPacket, 'side_data'>,
  width: number,
  height: number,
): Pick<EncodedFrame, 'psnr' | 'qp'> {
  const stats = packet.side_data?.find((d) => d.type === QUALITY_STATS);
  if (!stats || stats.data.byteLength < 8) return {};
  const d = stats.data;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const qp = Math.round(view.getUint32(0, true) / QP2LAMBDA);
  const count = view.getUint8(5);
  if (count < 3 || d.byteLength < 8 + 24) return { qp };
  const chroma = Math.ceil(width / 2) * Math.ceil(height / 2);
  const planes = [width * height, chroma, chroma];
  const db = (i: number): number => {
    const sse = Number(view.getBigUint64(8 + 8 * i, true));
    // a plane the encoder made exactly is as good as 8-bit samples measure
    if (sse <= 0) return 10 * Math.log10(255 * 255 * planes[i]);
    return 10 * Math.log10((255 * 255 * planes[i]) / sse);
  };
  return { qp, psnr: { y: db(0), u: db(1), v: db(2) } };
}

/** A bit rate for a size: about Chrome's start for a call, which it then
 *  adapts; nothing here adapts. */
export const bitRateFor = (width: number, height: number): number =>
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
    return packets.map((packet) => {
      return {
        data: packet.data,
        key: ((packet.flags ?? 0) & 1) === 1,
        ...qualityOf(packet, input.width!, input.height!),
      };
    });
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

/** Opus's rate, and a packet's samples at it: 20 ms. */
const OPUS_RATE = 48000;
const OPUS_FRAME = 960;

/** Opus as a call sends it: 48 kHz, 20 ms a packet, one channel. */
class OpusEncoder implements AudioEncoderLike {
  readonly sampleRate = OPUS_RATE;
  readonly frameSize = OPUS_FRAME;
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
  readonly sampleRate = OPUS_RATE;
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

// --- the codecs' thread -----------------------------------------------------

/** What a codec on the thread is. */
export type CodecKind =
  'video-encoder' | 'video-decoder' | 'audio-encoder' | 'audio-decoder';

/** Any of the four. */
export type AnyCodec =
  VideoEncoderLike | VideoDecoderLike | AudioEncoderLike | AudioDecoderLike;

/** What the page's thread posts to the codecs' thread: a codec opened under
 *  a number, a call of its `encode` or `decode`, and its end. */
export type ToCodecThread =
  | {
      op: 'open';
      id: number;
      kind: CodecKind;
      codec: VideoCodecName | AudioCodecName;
    }
  | {
      op: 'call';
      call: number;
      id: number;
      method: 'encode' | 'decode';
      args: unknown[];
    }
  | { op: 'close'; id: number };

/** What the codecs' thread posts back: that its modules are in, and whether
 *  libav.js was among them; and what a call came to, nothing where it
 *  failed. */
export type FromCodecThread =
  { op: 'up'; libav: boolean } | { op: 'done'; call: number; result: unknown };

/** One of libav.js's codecs, made on the thread this runs on. */
export function codecHere(
  libav: LibAVInstance,
  kind: CodecKind,
  codec: VideoCodecName | AudioCodecName,
): AnyCodec | null {
  if (kind === 'video-encoder' || kind === 'video-decoder') {
    if (codec !== 'VP8' && codec !== 'VP9') return null;
    return kind === 'video-encoder'
      ? new LibAVVideoEncoder(libav, codec)
      : new LibAVVideoDecoder(libav, codec);
  }
  if (codec !== 'OPUS') return null;
  return kind === 'audio-encoder'
    ? new OpusEncoder(libav)
    : new OpusDecoder(libav);
}

/** The buffers under what a codec is handed or hands back, each once, to be
 *  transferred: frames, packets and samples, in arrays and objects a few
 *  deep. A shared buffer stays out, since it cannot be. */
export function buffersOf(value: unknown): ArrayBuffer[] {
  const found = new Set<ArrayBuffer>();
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) found.add(v.buffer);
      return;
    }
    for (const item of Array.isArray(v) ? v : Object.values(v)) {
      walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return [...found];
}

/**
 * The thread, for a test: the entry's name beside this module, whether
 * codecs run on the page's thread from now on, and how many threads were
 * started and run now. A thread that cannot be made, or that loads no
 * libav.js, sets `pageThread`, so the next codec does not try again.
 */
export const codecThreads = {
  entry: 'media-codec-thread',
  pageThread: false,
  started: 0,
  running: 0,
};

/**
 * The worker the process's codecs run on, one at a time. It is made with the
 * first codec and ends with the last, and it holds the process open only
 * while an answer is due: as it starts, and while a call is on it. A
 * listener for `message` refs a `Worker` again, so its holding is set after
 * the listeners, each time it changes.
 *
 * It ends only once it has said its modules are in: in Node 24.14 to 24.18,
 * 25.7 to 25.9 and 26.0 to 26.3, a thread terminated in the middle of the
 * native CommonJS lexer aborts the process (nodejs/node#63323, `PageWorkers`
 * has the same rule).
 */
class CodecThread {
  /** Whether its modules are in with libav.js among them, once it says; null
   *  where it could not be made or ended before it said. */
  readonly up: Promise<boolean | null>;
  private _say: (up: boolean | null) => void = () => {};
  private _worker: WorkerLike | null = null;
  private _isUp = false;
  private _gone = false;
  private _codecs = 0;
  private readonly _calls = new Map<number, (result: unknown) => void>();
  private _next = 0;

  constructor() {
    this.up = new Promise((say) => (this._say = say));
    codecThreads.started += 1;
    codecThreads.running += 1;
    void this._start();
  }

  private async _start(): Promise<void> {
    let worker: WorkerLike;
    try {
      const { Worker } =
        await nodeModule<WorkerThreadsModule>('worker_threads');
      const source = threadEntry(
        (import.meta as { url: string }).url,
        codecThreads.entry,
      )();
      worker = new Worker(source, {
        name: 'media codecs',
        eval: typeof source === 'string',
      });
    } catch {
      this._lost();
      return;
    }
    this._worker = worker;
    worker.on('message', (m: never) => this._heard(m as FromCodecThread));
    worker.on('error', () => this._lost());
    worker.on('exit', () => this._lost());
    this._hold();
  }

  private _heard(m: FromCodecThread): void {
    if (m.op === 'up') {
      this._isUp = true;
      this._say(m.libav);
      if (this._codecs === 0) this._end();
    } else {
      const answer = this._calls.get(m.call);
      this._calls.delete(m.call);
      answer?.(m.result);
    }
    this._hold();
  }

  /** It holds the process open while an answer is due, and not otherwise. */
  private _hold(): void {
    const worker = this._worker;
    if (!worker || this._gone) return;
    if (!this._isUp || this._calls.size) worker.ref();
    else worker.unref();
  }

  /** A codec is to be made on it: it stays until that codec leaves. */
  enter(): number {
    this._codecs += 1;
    return (this._next += 1);
  }

  /** A codec that entered leaves, closed where it was opened. */
  leave(id: number, opened: boolean): void {
    if (opened) this.post({ op: 'close', id });
    this._codecs -= 1;
    if (this._codecs === 0) this._end();
  }

  post(m: ToCodecThread, transfer: ArrayBuffer[] = []): boolean {
    const worker = this._worker;
    if (!worker || this._gone) return false;
    try {
      worker.postMessage(m, transfer);
    } catch {
      // a buffer that cannot be moved — WebAssembly's memory — is copied
      try {
        worker.postMessage(m);
      } catch {
        return false;
      }
    }
    return true;
  }

  /** A codec's `encode` or `decode` on the thread: what it came to, or
   *  undefined where the thread went before it answered. */
  call(
    id: number,
    method: 'encode' | 'decode',
    args: unknown[],
    transfer: ArrayBuffer[],
  ): Promise<unknown> {
    const call = (this._next += 1);
    return new Promise((answer) => {
      this._calls.set(call, answer);
      if (!this.post({ op: 'call', call, id, method, args }, transfer)) {
        this._calls.delete(call);
        answer(undefined);
        return;
      }
      this._hold();
    });
  }

  /** The last codec left: it goes, once it is up. */
  private _end(): void {
    if (!this._isUp || this._gone) return;
    const worker = this._worker;
    this._lost();
    void worker?.terminate().catch(() => {});
  }

  /** It went, or never came: what was asked of it answers nothing, and the
   *  next codec makes another — or, where none ever came up, runs here. */
  private _lost(): void {
    if (this._gone) return;
    this._gone = true;
    codecThreads.running -= 1;
    if (current === this) current = null;
    if (!this._isUp) {
      codecThreads.pageThread = true;
      this._say(null);
    }
    for (const answer of this._calls.values()) answer(undefined);
    this._calls.clear();
    this._worker = null;
  }
}

let current: CodecThread | null = null;

/** A frame's planes copied into one buffer of its own, which is moved to
 *  the thread: a source's frame is read until its next and not after. */
function ownFrame(frame: MediaVideoFrame): MediaVideoFrame {
  let size = 0;
  for (const plane of frame.planes) size += plane.byteLength;
  const all = new Uint8Array(size);
  let at = 0;
  const planes = frame.planes.map((plane) => {
    all.set(plane, at);
    at += plane.byteLength;
    return all.subarray(at - plane.byteLength, at);
  });
  return {
    format: frame.format,
    width: frame.width,
    height: frame.height,
    planes,
    strides: frame.strides.slice(),
    colorSpace: frame.colorSpace,
    range: frame.range,
    timestamp: frame.timestamp,
  };
}

/** A codec on the thread, by its number. What it is handed is copied once
 *  and the copy moved there, so a caller keeps what it handed over; what it
 *  hands back was made there and is moved back. */
class ThreadCodec {
  private _closed = false;

  constructor(
    private readonly _thread: CodecThread,
    private readonly _id: number,
  ) {}

  protected async _ask<R>(
    method: 'encode' | 'decode',
    args: unknown[],
    empty: R,
  ): Promise<R> {
    if (this._closed) return empty;
    const result = await this._thread.call(
      this._id,
      method,
      args,
      buffersOf(args),
    );
    return this._closed || result === undefined ? empty : (result as R);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._thread.leave(this._id, true);
  }
}

class ThreadVideoEncoder extends ThreadCodec implements VideoEncoderLike {
  encode(
    frame: MediaVideoFrame,
    key: boolean,
    time: number,
  ): Promise<EncodedFrame[]> {
    return this._ask<EncodedFrame[]>(
      'encode',
      [ownFrame(frame), key, time],
      [],
    );
  }
}

class ThreadVideoDecoder extends ThreadCodec implements VideoDecoderLike {
  decode(data: Uint8Array): Promise<MediaVideoFrame[]> {
    return this._ask<MediaVideoFrame[]>('decode', [new Uint8Array(data)], []);
  }
}

class ThreadAudioEncoder extends ThreadCodec implements AudioEncoderLike {
  readonly sampleRate = OPUS_RATE;
  readonly frameSize = OPUS_FRAME;
  encode(samples: Float32Array): Promise<Uint8Array[]> {
    return this._ask<Uint8Array[]>('encode', [samples.slice()], []);
  }
}

class ThreadAudioDecoder extends ThreadCodec implements AudioDecoderLike {
  readonly sampleRate = OPUS_RATE;
  decode(data: Uint8Array): Promise<Float32Array[] | null> {
    return this._ask<Float32Array[] | null>(
      'decode',
      [new Uint8Array(data)],
      null,
    );
  }
}

/**
 * A codec opened on the thread: what `make` makes of it, or undefined where
 * it is to be made on this thread instead. Entered at once, before anything
 * is awaited, so a codec that replaces another — the pipeline closes the old
 * one in a microtask — keeps the thread from ending between the two.
 */
async function onThread<T>(
  kind: CodecKind,
  codec: VideoCodecName | AudioCodecName,
  make: (thread: CodecThread, id: number) => T,
): Promise<T | undefined> {
  if (codecThreads.pageThread) return undefined;
  const thread = (current ??= new CodecThread());
  const id = thread.enter();
  const up = await thread.up;
  if (up !== true) {
    // no libav.js there: none here either, most likely, which the page's
    // thread finds out at the cost of a failed import
    if (up === false) codecThreads.pageThread = true;
    thread.leave(id, false);
    return undefined;
  }
  thread.post({ op: 'open', id, kind, codec });
  return make(thread, id);
}

// --- what the pipeline is handed --------------------------------------------

/** Each kind's codecs, made where they can be — on the codecs' thread, or
 *  on this one where no thread can be made: null for one libav.js, not
 *  installed, would have made. */
export async function videoEncoder(
  codec: VideoCodecName,
): Promise<VideoEncoderLike | null> {
  const there = await onThread(
    'video-encoder',
    codec,
    (t, id) => new ThreadVideoEncoder(t, id),
  );
  if (there) return there;
  const libav = await loadLibAV();
  return libav ? new LibAVVideoEncoder(libav, codec) : null;
}
export async function videoDecoder(
  codec: VideoCodecName,
): Promise<VideoDecoderLike | null> {
  const there = await onThread(
    'video-decoder',
    codec,
    (t, id) => new ThreadVideoDecoder(t, id),
  );
  if (there) return there;
  const libav = await loadLibAV();
  return libav ? new LibAVVideoDecoder(libav, codec) : null;
}
export async function audioEncoder(
  codec: AudioCodecName,
): Promise<AudioEncoderLike | null> {
  if (codec === 'PCMU' || codec === 'PCMA') {
    return new G711Encoder(codec === 'PCMU');
  }
  const there = await onThread(
    'audio-encoder',
    codec,
    (t, id) => new ThreadAudioEncoder(t, id),
  );
  if (there) return there;
  const libav = await loadLibAV();
  return libav ? new OpusEncoder(libav) : null;
}
export async function audioDecoder(
  codec: AudioCodecName,
): Promise<AudioDecoderLike | null> {
  if (codec === 'PCMU' || codec === 'PCMA') {
    return new G711Decoder(codec === 'PCMU');
  }
  const there = await onThread(
    'audio-decoder',
    codec,
    (t, id) => new ThreadAudioDecoder(t, id),
  );
  if (there) return there;
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
