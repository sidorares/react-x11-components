// What a werift connection's transceivers send and receive: the media
// pipeline under the `HtmlWebRTC` seam (`./rtc.ts`, docs/prd-webrtc.md,
// workstream 4). A sender reads its track's frames, encodes them
// (`./media-codecs.ts`), packetizes them with werift's packetizers and
// writes the packets into the werift track its RTP sender sends from; a
// receiver is the source a page's remote track is over, which hears the
// packets werift's RTP receiver routes to it, keeps the sources
// `getSynchronizationSources` answers from, and decodes them into the
// frames a `<video srcObject>` shows.
//
// werift's types here are written out structurally, as `./werift.ts`'s
// are, so an app that did not install it still type-checks.
//
// Three decisions, each a browser's:
//   - **A remote track is muted until media arrives**, and again once none
//     has for `MUTE_AFTER_MS`. werift sends no RTCP BYE as a sender stops
//     or a connection closes, which is what Chrome mutes on, so silence is
//     the signal; and a sender whose source gives no new frame — a canvas
//     nobody draws on — sends its last again each second, as Chrome's
//     encoder does, so that a still picture is not taken for a peer gone.
//   - **What arrives is decoded whether or not anything shows it**, as a
//     browser decodes it: a frame's and a sample's counts and timing are
//     its stats, and `jitterBufferTarget` holds each until it is due. A
//     decoder that starts, or that lost a packet, waits for a key frame and
//     asks for one (RTCP PLI), and a sender makes one where asked. There is
//     no jitter buffer beyond that hold yet: a packet out of order is a
//     loss.
//   - **What a packet costs to encode is never held against the page's
//     next frame**: a video frame that arrives while the last is being
//     encoded replaces any other waiting, so a slow encoder drops frames
//     rather than falling behind.

import {
  Resampler,
  audioCodecOf,
  audioDecoder,
  audioEncoder,
  videoCodecOf,
  videoDecoder,
  videoEncoder,
} from './media-codecs.js';
import type {
  AudioCodecName,
  AudioDecoderLike,
  AudioEncoderLike,
  VideoCodecName,
  VideoDecoderLike,
  VideoEncoderLike,
} from './media-codecs.js';
import { toI420 } from './media-devices.js';
import type {
  MediaAudioData,
  MediaSettings,
  MediaSourceEvents,
  MediaSourceLike,
  MediaVideoFrame,
} from './media-devices.js';
import type { RTCRtpSourceLike } from './rtc.js';

declare const setInterval: (fn: () => void, ms: number) => unknown;
declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const clearInterval: (handle: unknown) => void;
declare const performance: { now(): number; timeOrigin: number };
declare const Buffer: {
  from(bytes: ArrayBufferLike, offset: number, length: number): Uint8Array;
};

// --- werift's shape, the slice read here ------------------------------------

interface WEvent<A extends unknown[]> {
  subscribe(fn: (...args: A) => void): unknown;
}

export interface WMediaCodec {
  payloadType?: number;
  mimeType: string;
  clockRate: number;
  channels?: number;
}

export interface WRtpHeader {
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  marker: boolean;
  payloadType: number;
  csrc: number[];
  extensions: { id: number; payload: Uint8Array }[];
}

export interface WRtpPacket {
  header: WRtpHeader;
  payload: Uint8Array;
}

/** A werift track: a sender's, which RTP written into it is sent from, or
 *  one of a receiver's, which RTP from the peer arrives on. */
export interface WMediaTrack {
  readonly ssrc?: number;
  readonly onReceiveRtp: WEvent<[WRtpPacket, Record<string, unknown>?]>;
  writeRtp(rtp: WRtpPacket): void;
}

export interface WMediaTransceiver {
  readonly kind: 'audio' | 'video';
  readonly mid: string | null;
  readonly codecs: WMediaCodec[];
  readonly headerExtensions: { id: number; uri: string }[];
  readonly onTrack?: WEvent<[WMediaTrack]>;
  readonly sender: {
    readonly ssrc: number;
    readonly codec?: WMediaCodec;
    readonly stopped?: boolean;
    readonly sendSuppressed?: boolean;
    readonly dtlsTransport?: { readonly state: string };
    readonly onKeyFrameRequest?: WEvent<[string]>;
    readonly onPictureLossIndication?: WEvent<[]>;
  };
  readonly receiver: {
    readonly tracks: WMediaTrack[];
    sendRtcpPLI(ssrc: number): Promise<void>;
  };
}

interface WPacketizer {
  packetize(data: Uint8Array, rtpTimestamp: number): WRtpPacket[];
}
type WPacketizerClass = new (options: { payloadType?: number }) => WPacketizer;

/** What of werift the pipeline uses: its packetizers, its depacketizer and
 *  the audio level extension's encoding. */
export interface WeriftMediaModule {
  Vp8Packetizer: WPacketizerClass;
  Vp9Packetizer: WPacketizerClass;
  OpusPacketizer: WPacketizerClass;
  PcmuPacketizer: WPacketizerClass;
  PcmaPacketizer: WPacketizerClass;
  dePacketizeRtpPackets(
    codec: string,
    packets: WRtpPacket[],
  ): { isKeyframe: boolean; data: Uint8Array };
  serializeAudioLevelIndication(level: number): Uint8Array;
}

/** Whether a werift module has what the pipeline needs. */
export function hasMedia(w: unknown): w is WeriftMediaModule {
  const m = w as Partial<WeriftMediaModule> | null;
  return (
    !!m &&
    typeof m.Vp8Packetizer === 'function' &&
    typeof m.OpusPacketizer === 'function' &&
    typeof m.dePacketizeRtpPackets === 'function' &&
    typeof m.serializeAudioLevelIndication === 'function'
  );
}

// --- shared -------------------------------------------------------------------

const AUDIO_LEVEL = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';

/** How long a remote track goes with no packet before it is muted. */
export const MUTE_AFTER_MS = 2000;
/** How long a sender goes with no new frame before it sends its last
 *  again. */
const REPEAT_AFTER_MS = 1000;
/** How long `getSynchronizationSources` remembers a source (WebRTC 1.0,
 *  5.3.1). */
const SOURCE_MEMORY_MS = 10000;

/** The page's time, as `performance.timeOrigin + performance.now()`: what a
 *  synchronization source's `timestamp` and a stats object's are on. */
export const pageTime = (): number =>
  performance.timeOrigin + performance.now();

const bytes = (data: Uint8Array): Uint8Array =>
  Buffer.from(data.buffer, data.byteOffset, data.byteLength);

/** A frame copied out of its source's buffers, which the next frame may
 *  reuse: I420, each plane its own. */
function copied(frame: MediaVideoFrame): MediaVideoFrame {
  const f = toI420(frame);
  return {
    ...f,
    format: 'I420',
    planes: f.planes.map((p) => p.slice()),
  };
}

/** A chunk's samples as one channel: the mean of its channels. */
function mono(data: MediaAudioData): Float32Array {
  const [first, ...rest] = data.channels;
  if (!first) return new Float32Array(data.frames);
  if (!rest.length) return first.subarray(0, data.frames);
  const out = new Float32Array(data.frames);
  for (const c of data.channels) {
    for (let i = 0; i < data.frames; i++) out[i] += c[i] ?? 0;
  }
  const n = data.channels.length;
  for (let i = 0; i < data.frames; i++) out[i] /= n;
  return out;
}

/** A packet's level as RFC 6464 has it: its RMS in -dBov, 0 the loudest and
 *  127 silence. */
export function audioLevelOf(samples: Float32Array): number {
  const rms = rmsOf(samples);
  if (rms <= 0) return 127;
  return Math.max(0, Math.min(127, Math.round(-20 * Math.log10(rms))));
}

/** Samples' root mean square: an audio level, linear, 1 at 0 dBov. */
function rmsOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** Times of the last second, the older ones dropped: what a rate is
 *  counted from. */
function recent(times: number[]): number[] {
  const since = performance.now() - 1000;
  let drop = 0;
  while (drop < times.length && times[drop] < since) drop++;
  if (drop) times.splice(0, drop);
  return times;
}

/** A random 32-bit start, as RTP's timestamps have (RFC 3550, 5.1). */
const randomStart = (): number => (Math.random() * 0x100000000) >>> 0;

/** `a` comes after `b` in a 16-bit sequence that wraps. */
const seqAfter = (a: number, b: number): boolean =>
  ((a - b) & 0xffff) !== 0 && ((a - b) & 0xffff) < 0x8000;

// --- sending ------------------------------------------------------------------

/**
 * What a transceiver's sender sends: the frames of the source it is handed,
 * encoded in the codec the last description negotiated, as RTP written into
 * the werift track `replaceTrack` gave its RTP sender. It encodes only while
 * werift can send — a codec negotiated, DTLS connected, the direction
 * sending — and starts each run of sending with a key frame.
 */
export class MediaSender {
  private _source: MediaSourceLike | null = null;
  private _track: WMediaTrack | null = null;
  private _stopped = false;
  private _sending = false;
  private _wantKey = true;
  private _repeat: unknown = null;
  /** What it read and encoded, which its stats report. */
  private readonly _count = {
    framesEncoded: 0,
    keyFramesEncoded: 0,
    framesSent: 0,
    totalEncodeTime: 0,
    width: 0,
    height: 0,
    sent: [] as number[],
    read: [] as number[],
    sourceFrames: 0,
    sourceWidth: 0,
    sourceHeight: 0,
    level: 0,
    energy: 0,
    duration: 0,
    since: performance.now(),
  };

  // video
  private _videoCodec: VideoCodecName | null = null;
  private _video: Promise<VideoEncoderLike | null> | null = null;
  private _latest: MediaVideoFrame | null = null;
  private _encodedLatest = false;
  private _lastSentAt = 0;
  private _busy = false;
  private _packetizer: WPacketizer | null = null;
  private _packetizerKey = '';
  private readonly _start = randomStart();
  private readonly _clock = performance.now();

  // audio
  private _audioCodec: AudioCodecName | null = null;
  private _audio: AudioEncoderLike | null = null;
  private _audioMaking: Promise<AudioEncoderLike | null> | null = null;
  private _resampler: Resampler | null = null;
  private _pending: Float32Array = new Float32Array(0);
  private _audioTime = randomStart();

  constructor(
    private readonly _w: WeriftMediaModule,
    private readonly _t: WMediaTransceiver,
  ) {
    const key = () => {
      this._wantKey = true;
      this._encodedLatest = false;
      this._pump();
    };
    _t.sender.onKeyFrameRequest?.subscribe(key);
  }

  /** What it sends from now on: a source's frames, into a werift track,
   *  or nothing. */
  attach(source: MediaSourceLike | null, track: WMediaTrack | null): void {
    if (this._source && this._source !== source) {
      this._source.listen({ muted() {}, ended() {} });
      this._source.stop();
    }
    this._source = source;
    this._track = track;
    this._latest = null;
    this._encodedLatest = false;
    this._wantKey = true;
    this._pending = new Float32Array(0);
    if (!source || this._stopped) {
      this._stopRepeat();
      return;
    }
    source.listen({
      muted() {},
      ended() {},
      ...(this._t.kind === 'video'
        ? { video: (frame: MediaVideoFrame) => this._frame(frame) }
        : { audio: (data: MediaAudioData) => this._chunk(data) }),
    });
    if (this._t.kind === 'video' && this._repeat === null) {
      this._repeat = setInterval(() => this._tick(), REPEAT_AFTER_MS / 2);
      (this._repeat as { unref?(): void }).unref?.();
    }
  }

  /** Sends nothing more, for good. */
  stop(): void {
    if (this._stopped) return;
    this.attach(null, null);
    this._stopped = true;
    void this._video?.then((e) => e?.close());
    this._audio?.close();
    this._video = null;
    this._audio = null;
  }

  private _stopRepeat(): void {
    if (this._repeat !== null) clearInterval(this._repeat);
    this._repeat = null;
  }

  /** Whether werift would send a packet written now, and the codec it
   *  would send it in. */
  private _sendable(): boolean {
    const s = this._t.sender;
    const ok =
      !this._stopped &&
      !!this._track &&
      !!s.codec &&
      !s.stopped &&
      !s.sendSuppressed &&
      s.dtlsTransport?.state === 'connected';
    // a run of sending starts with a key frame, which is what a receiver
    // that has heard nothing yet can begin decoding at
    if (ok && !this._sending) this._wantKey = true;
    this._sending = ok;
    return ok;
  }

  /**
   * What it adds to its outbound-rtp and to its track's media-source stats
   * (WebRTC Statistics, 5.6 and 5.12): what its source gave and what it
   * encoded and sent, a video's frames and sizes, an audio's level.
   */
  stats(): {
    outbound: Record<string, unknown>;
    source: Record<string, unknown>;
  } {
    const c = this._count;
    const now = performance.now();
    if (this._t.kind === 'audio') {
      return {
        outbound: { active: !this._stopped },
        source: {
          audioLevel: c.level,
          totalAudioEnergy: c.energy,
          totalSamplesDuration: c.duration,
        },
      };
    }
    return {
      outbound: {
        active: !this._stopped,
        framesEncoded: c.framesEncoded,
        keyFramesEncoded: c.keyFramesEncoded,
        framesSent: c.framesSent,
        hugeFramesSent: 0,
        totalEncodeTime: c.totalEncodeTime,
        totalPacketSendDelay: 0,
        encoderImplementation: 'libvpx',
        powerEfficientEncoder: false,
        qualityLimitationReason: 'none',
        qualityLimitationDurations: {
          none: (now - c.since) / 1000,
          cpu: 0,
          bandwidth: 0,
          other: 0,
        },
        qualityLimitationResolutionChanges: 0,
        ...(c.width
          ? {
              frameWidth: c.width,
              frameHeight: c.height,
              framesPerSecond: recent(c.sent).length,
            }
          : {}),
      },
      source: {
        frames: c.sourceFrames,
        framesPerSecond: recent(c.read).length,
        ...(c.sourceWidth
          ? { width: c.sourceWidth, height: c.sourceHeight }
          : {}),
      },
    };
  }

  // --- video --------------------------------------------------------------

  private _frame(frame: MediaVideoFrame): void {
    if (this._stopped) return;
    const c = this._count;
    c.sourceFrames += 1;
    c.sourceWidth = frame.width;
    c.sourceHeight = frame.height;
    recent(c.read).push(performance.now());
    this._latest = copied(frame);
    this._encodedLatest = false;
    this._pump();
  }

  /** The last frame sent again, where no new one came for a second. */
  private _tick(): void {
    if (!this._latest || this._busy) return;
    if (performance.now() - this._lastSentAt < REPEAT_AFTER_MS) return;
    this._encodedLatest = false;
    this._pump();
  }

  private _encoder(): Promise<VideoEncoderLike | null> | null {
    const mime = this._t.sender.codec?.mimeType ?? '';
    const codec = videoCodecOf(mime);
    if (!codec) return null;
    if (codec !== this._videoCodec || !this._video) {
      void this._video?.then((e) => e?.close());
      this._videoCodec = codec;
      this._video = videoEncoder(codec);
      this._wantKey = true;
    }
    return this._video;
  }

  private _pump(): void {
    if (this._busy || this._encodedLatest || !this._latest) return;
    if (!this._sendable()) return;
    const making = this._encoder();
    if (!making) return;
    const frame = this._latest;
    const key = this._wantKey;
    this._encodedLatest = true;
    this._busy = true;
    // the encoder's clock only goes forward; RTP's starts anywhere and
    // wraps (RFC 3550, 5.1)
    const ticks = Math.round((performance.now() - this._clock) * 90);
    const time = (this._start + ticks) >>> 0;
    void making
      .then(async (encoder) => {
        if (!encoder || !this._sendable()) return;
        const began = performance.now();
        const chunks = await encoder.encode(frame, key, ticks);
        const c = this._count;
        c.totalEncodeTime += (performance.now() - began) / 1000;
        c.framesEncoded += chunks.length ? 1 : 0;
        c.keyFramesEncoded += chunks.some((x) => x.key) ? 1 : 0;
        c.width = frame.width;
        c.height = frame.height;
        if (!chunks.length) return;
        if (key && chunks.some((c) => c.key)) this._wantKey = false;
        this._lastSentAt = performance.now();
        const codec = this._t.sender.codec;
        if (!codec || !this._track) return;
        const packetizer = this._packetizerFor(codec);
        if (!packetizer) return;
        for (const chunk of chunks) {
          for (const packet of packetizer.packetize(bytes(chunk.data), time)) {
            this._track.writeRtp(packet);
          }
        }
        c.framesSent += 1;
        recent(c.sent).push(performance.now());
      })
      .catch(() => {})
      .finally(() => {
        this._busy = false;
        this._pump();
      });
  }

  private _packetizerFor(codec: WMediaCodec): WPacketizer | null {
    const key = `${codec.mimeType}/${codec.payloadType}`;
    if (this._packetizer && this._packetizerKey === key)
      return this._packetizer;
    const name = codec.mimeType.split('/')[1]?.toUpperCase();
    const make: WPacketizerClass | undefined =
      name === 'VP8'
        ? this._w.Vp8Packetizer
        : name === 'VP9'
          ? this._w.Vp9Packetizer
          : name === 'OPUS'
            ? this._w.OpusPacketizer
            : name === 'PCMU'
              ? this._w.PcmuPacketizer
              : name === 'PCMA'
                ? this._w.PcmaPacketizer
                : undefined;
    if (!make) return null;
    this._packetizer = new make({ payloadType: codec.payloadType ?? 96 });
    this._packetizerKey = key;
    return this._packetizer;
  }

  // --- audio --------------------------------------------------------------

  private _chunk(data: MediaAudioData): void {
    if (this._stopped) return;
    // what the source gave, sent or not: its media-source stats
    const heard = mono(data);
    const rms = rmsOf(heard);
    const seconds = data.frames / data.sampleRate;
    this._count.level = rms;
    this._count.energy += rms * rms * seconds;
    this._count.duration += seconds;
    if (!this._sendable()) {
      this._pending = new Float32Array(0);
      return;
    }
    const codec = audioCodecOf(this._t.sender.codec?.mimeType ?? '');
    if (!codec) return;
    if (codec !== this._audioCodec) {
      this._audio?.close();
      this._audio = null;
      this._audioCodec = codec;
      this._resampler = null;
      this._pending = new Float32Array(0);
      const making = (this._audioMaking = audioEncoder(codec));
      void making.then((encoder) => {
        if (this._audioMaking !== making) encoder?.close();
        else this._audio = encoder;
      });
    }
    const encoder = this._audio;
    if (!encoder) return;
    if (
      !this._resampler ||
      this._resampler.from !== data.sampleRate ||
      this._resampler.to !== encoder.sampleRate
    ) {
      this._resampler = new Resampler(data.sampleRate, encoder.sampleRate);
    }
    const samples = this._resampler.push(heard);
    const all = new Float32Array(this._pending.length + samples.length);
    all.set(this._pending, 0);
    all.set(samples, this._pending.length);
    let at = 0;
    const size = encoder.frameSize;
    const codecInfo = this._t.sender.codec!;
    // the RTP clock is the codec's: 48 kHz for Opus, 8 kHz for G.711
    const step = Math.round((size * codecInfo.clockRate) / encoder.sampleRate);
    const level = this._t.headerExtensions.find((e) => e.uri === AUDIO_LEVEL);
    for (; at + size <= all.length; at += size) {
      const frame = all.slice(at, at + size);
      const time = this._audioTime;
      this._audioTime = (this._audioTime + step) >>> 0;
      const loudness = audioLevelOf(frame);
      void encoder.encode(frame).then((packets) => {
        const codec = this._t.sender.codec;
        if (!codec || !this._track || this._audio !== encoder) return;
        const packetizer = this._packetizerFor(codec);
        if (!packetizer) return;
        for (const data of packets) {
          for (const packet of packetizer.packetize(bytes(data), time)) {
            if (level) {
              packet.header.extensions.push({
                id: level.id,
                payload: this._w.serializeAudioLevelIndication(loudness),
              });
            }
            this._track.writeRtp(packet);
          }
        }
      });
    }
    this._pending = all.slice(at);
  }
}

// --- receiving ----------------------------------------------------------------

/** One RTP frame of video being put together: its packets, by timestamp. */
interface Assembling {
  timestamp: number;
  packets: WRtpPacket[];
  /** When its first packet arrived. */
  first: number;
}

/**
 * What a transceiver's receiver receives: the source a page's remote track
 * is over. Muted until a packet arrives on one of the receiver's werift
 * tracks, and again once none has for `MUTE_AFTER_MS`; decoded into frames,
 * which a listener that reads them is handed.
 */
export class MediaReceiver implements MediaSourceLike {
  readonly label = '';
  private _events: MediaSourceEvents | null = null;
  private _muted = true;
  private _ended = false;
  private _stopped = false;
  private readonly _heard = new WeakSet<WMediaTrack>();
  private readonly _sources = new Map<number, RTCRtpSourceLike>();
  private _lastPacket = 0;
  private _timer: unknown = null;
  /** Packets received, which inbound-rtp's lifetime starts at. */
  packets = 0;

  // video
  private _assembling: Assembling | null = null;
  private _lastSeq: number | null = null;
  private _needKey = true;
  private _lastAsked = 0;
  private _videoCodec: VideoCodecName | null = null;
  private _videoDecoder: Promise<VideoDecoderLike | null> | null = null;
  private _decoding: Promise<void> = Promise.resolve();
  private _queued = 0;
  private _size = { width: 0, height: 0 };
  private _firstTimestamp: number | null = null;

  // audio
  private _audioCodec: AudioCodecName | null = null;
  private _audioDecoder: Promise<AudioDecoderLike | null> | null = null;
  private _audioChain: Promise<void> = Promise.resolve();
  private _audioTime = 0;
  private _channels = 0;
  /** What it received, decoded and handed on, which its stats report. */
  private readonly _count = {
    framesReceived: 0,
    framesDecoded: 0,
    keyFramesDecoded: 0,
    framesDropped: 0,
    framesAssembledFromMultiplePackets: 0,
    totalAssemblyTime: 0,
    totalDecodeTime: 0,
    totalInterFrameDelay: 0,
    totalSquaredInterFrameDelay: 0,
    lastDecoded: 0,
    decoded: [] as number[],
    jitterBufferDelay: 0,
    jitterBufferTargetDelay: 0,
    jitterBufferMinimumDelay: 0,
    jitterBufferEmittedCount: 0,
    totalProcessingDelay: 0,
    totalSamplesReceived: 0,
    level: 0,
    energy: 0,
    duration: 0,
  };

  constructor(
    private readonly _w: WeriftMediaModule,
    private readonly _t: WMediaTransceiver,
  ) {
    _t.onTrack?.subscribe((track) => this._hear(track));
    this.watch();
  }

  get kind(): 'audio' | 'video' {
    return this._t.kind;
  }

  /** Listens to each of the receiver's werift tracks not listened to yet:
   *  a description made them. */
  watch(): void {
    for (const track of this._t.receiver.tracks) this._hear(track);
  }

  private _hear(track: WMediaTrack): void {
    if (this._heard.has(track)) return;
    this._heard.add(track);
    track.onReceiveRtp.subscribe((rtp, extensions) =>
      this._packet(rtp, extensions),
    );
  }

  /** The synchronization and contributing sources of the last ten
   *  seconds. */
  sources(): RTCRtpSourceLike[] {
    const since = pageTime() - SOURCE_MEMORY_MS;
    const out: RTCRtpSourceLike[] = [];
    for (const [key, s] of this._sources) {
      if (s.timestamp < since) this._sources.delete(key);
      else out.push({ ...s });
    }
    return out.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** The SSRCs it has heard: what its inbound-rtp stats are of. */
  ssrcs(): Set<number> {
    const out = new Set<number>();
    for (const t of this._t.receiver.tracks) if (t.ssrc) out.add(t.ssrc);
    for (const s of this._sources.values()) {
      if (s.kind === 'synchronization') out.add(s.source);
    }
    return out;
  }

  /**
   * What it adds to its inbound-rtp stats (WebRTC Statistics, 5.4): what it
   * received, decoded and handed on, a video's frames and an audio's
   * samples, level and energy. No jitter buffer holds what it receives, so
   * a frame's delay there is its wait for the decoder, and nothing is
   * concealed, paused or frozen.
   */
  stats(): Record<string, unknown> {
    const c = this._count;
    const common = {
      packetsDiscarded: 0,
      jitterBufferDelay: c.jitterBufferDelay,
      jitterBufferTargetDelay: c.jitterBufferTargetDelay,
      jitterBufferMinimumDelay: c.jitterBufferMinimumDelay,
      jitterBufferEmittedCount: c.jitterBufferEmittedCount,
    };
    if (this.kind === 'audio') {
      return {
        ...common,
        totalSamplesReceived: c.totalSamplesReceived,
        concealedSamples: 0,
        silentConcealedSamples: 0,
        concealmentEvents: 0,
        insertedSamplesForDeceleration: 0,
        removedSamplesForAcceleration: 0,
        audioLevel: c.level,
        totalAudioEnergy: c.energy,
        totalSamplesDuration: c.duration,
      };
    }
    return {
      ...common,
      framesReceived: c.framesReceived,
      framesDecoded: c.framesDecoded,
      keyFramesDecoded: c.keyFramesDecoded,
      framesRendered: c.framesDecoded,
      framesDropped: c.framesDropped,
      framesPerSecond: recent(c.decoded).length,
      totalDecodeTime: c.totalDecodeTime,
      totalProcessingDelay: c.totalProcessingDelay,
      totalInterFrameDelay: c.totalInterFrameDelay,
      totalSquaredInterFrameDelay: c.totalSquaredInterFrameDelay,
      framesAssembledFromMultiplePackets: c.framesAssembledFromMultiplePackets,
      totalAssemblyTime: c.totalAssemblyTime,
      pauseCount: 0,
      totalPausesDuration: 0,
      freezeCount: 0,
      totalFreezesDuration: 0,
      decoderImplementation: 'libvpx',
      powerEfficientDecoder: false,
      ...(this._size.width
        ? { frameWidth: this._size.width, frameHeight: this._size.height }
        : {}),
    };
  }

  // --- the source ---------------------------------------------------------

  listen(events: MediaSourceEvents): void {
    this._events = events;
    if (this._ended) return;
    events.muted(this._muted);
  }

  /** `receiver.jitterBufferTarget`: a frame is handed on no sooner than
   *  this long after its first packet arrived, or as soon as it is decoded
   *  for null. */
  setTarget(ms: number | null): void {
    this._target = ms ?? 0;
  }
  private _target = 0;

  /**
   * Hands a decoded frame or chunk on once the jitter buffer target has
   * passed since it arrived, and counts the wait as its time in the buffer
   * (WebRTC Statistics, `jitterBufferDelay`): `units` frames of video, or
   * samples of audio, each of which waited it.
   */
  private _emit(arrived: number, units: number, hand: () => void): void {
    const go = () => {
      if (this._ended) return;
      const c = this._count;
      const waited = (performance.now() - arrived) / 1000;
      c.jitterBufferDelay += units * waited;
      c.jitterBufferTargetDelay += (units * this._target) / 1000;
      c.jitterBufferMinimumDelay += (units * this._target) / 1000;
      c.jitterBufferEmittedCount += units;
      hand();
    };
    const wait = arrived + this._target - performance.now();
    if (wait <= 1) return go();
    const timer = setTimeout(go, wait);
    (timer as { unref?(): void }).unref?.();
  }

  settings(): MediaSettings {
    if (this.kind === 'audio') {
      return { sampleRate: 48000, channelCount: this._channels || 1 };
    }
    return this._size.width
      ? { width: this._size.width, height: this._size.height }
      : {};
  }

  capabilities() {
    return {};
  }

  reconfigure(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** The page stopped its last track of it: nothing more is decoded. */
  stop(): void {
    this._stopped = true;
    this._events = null;
  }

  /** The transceiver is done with it, or its connection: no more packets
   *  are heard, and nothing is told. */
  end(): void {
    this._ended = true;
    this._events = null;
    if (this._timer !== null) clearInterval(this._timer);
    this._timer = null;
    void this._videoDecoder?.then((d) => d?.close());
    void this._audioDecoder?.then((d) => d?.close());
  }

  // --- packets --------------------------------------------------------------

  private _packet(rtp: WRtpPacket, extensions?: Record<string, unknown>): void {
    if (this._ended) return;
    const now = pageTime();
    this._lastPacket = now;
    this.packets += 1;
    const { header } = rtp;
    const level =
      this.kind === 'audio' ? this._levelOf(rtp, extensions) : undefined;
    this._sources.set(header.ssrc, {
      kind: 'synchronization',
      source: header.ssrc,
      timestamp: now,
      rtpTimestamp: header.timestamp >>> 0,
      ...(level !== undefined ? { audioLevel: level } : {}),
    });
    for (const csrc of header.csrc ?? []) {
      this._sources.set(-1 - csrc, {
        kind: 'contributing',
        source: csrc,
        timestamp: now,
        rtpTimestamp: header.timestamp >>> 0,
      });
    }
    if (this._muted) {
      this._muted = false;
      this._events?.muted(false);
    }
    if (this._timer === null) {
      this._timer = setInterval(() => this._quiet(), 250);
      (this._timer as { unref?(): void }).unref?.();
    }
    if (this._stopped) return;
    if (this.kind === 'video') {
      if (header.marker) this._count.framesReceived += 1;
      // decoded whether or not anything shows it, as a browser decodes
      // it: its frames and their timing are its stats
      this._video(rtp);
    } else {
      // audio is decoded whether or not anything plays it, as a browser
      // plays it out: its level and energy are its stats
      this._audio(rtp);
    }
  }

  /** Muted once no packet has come for a while. */
  private _quiet(): void {
    if (this._ended || this._muted) return;
    if (pageTime() - this._lastPacket < MUTE_AFTER_MS) return;
    this._muted = true;
    if (this._timer !== null) clearInterval(this._timer);
    this._timer = null;
    this._events?.muted(true);
  }

  /** A packet's audio level as a source reports it: linear, 0 to 1, from
   *  the -dBov the sender put in its extension (WebRTC 1.0, 5.3.1). */
  private _levelOf(
    rtp: WRtpPacket,
    extensions?: Record<string, unknown>,
  ): number | undefined {
    let dbov: number | undefined;
    const parsed = extensions?.[AUDIO_LEVEL] as { level?: number } | undefined;
    if (parsed && typeof parsed.level === 'number') dbov = parsed.level;
    else {
      const id = this._t.headerExtensions.find(
        (e) => e.uri === AUDIO_LEVEL,
      )?.id;
      const raw =
        id !== undefined
          ? rtp.header.extensions.find((e) => e.id === id)
          : undefined;
      if (raw && raw.payload.length) dbov = raw.payload[0] & 0x7f;
    }
    return dbov === undefined ? undefined : Math.pow(10, -dbov / 20);
  }

  private _codecOf(payloadType: number): WMediaCodec | undefined {
    return this._t.codecs.find((c) => c.payloadType === payloadType);
  }

  // --- video --------------------------------------------------------------

  private _askKey(): void {
    const at = performance.now();
    if (at - this._lastAsked < 500) return;
    this._lastAsked = at;
    for (const ssrc of this.ssrcs()) {
      this._t.receiver.sendRtcpPLI(ssrc).catch(() => {});
    }
  }

  private _lost(): void {
    this._needKey = true;
    this._assembling = null;
    this._askKey();
  }

  private _video(rtp: WRtpPacket): void {
    const { header } = rtp;
    const codec = videoCodecOf(
      this._codecOf(header.payloadType)?.mimeType ?? '',
    );
    if (!codec) return;
    const seq = header.sequenceNumber;
    if (this._lastSeq !== null && ((seq - this._lastSeq) & 0xffff) !== 1) {
      // one sent again after a NACK, or a duplicate: had already
      if (!seqAfter(seq, this._lastSeq)) return;
      // a packet missing: what it was part of cannot be decoded, nor what
      // follows until a key frame (there is no jitter buffer to wait in)
      this._lost();
    }
    this._lastSeq = seq;
    if (this._assembling && this._assembling.timestamp !== header.timestamp) {
      // a new frame before the last one's marker: its end was lost
      this._lost();
    }
    const frame = (this._assembling ??= {
      timestamp: header.timestamp,
      packets: [],
      first: performance.now(),
    });
    frame.packets.push(rtp);
    if (!header.marker) return;
    this._assembling = null;
    const c = this._count;
    if (frame.packets.length > 1) {
      c.framesAssembledFromMultiplePackets += 1;
      c.totalAssemblyTime += (performance.now() - frame.first) / 1000;
    }
    const { packets } = frame;
    let whole: { isKeyframe: boolean; data: Uint8Array };
    try {
      whole = this._w.dePacketizeRtpPackets(codec, packets);
    } catch {
      this._lost();
      return;
    }
    if (this._needKey && !whole.isKeyframe) {
      c.framesDropped += 1;
      this._askKey();
      return;
    }
    this._needKey = false;
    this._decode(
      codec,
      whole.data,
      frame.timestamp,
      frame.first,
      whole.isKeyframe,
    );
  }

  private _decode(
    codec: VideoCodecName,
    data: Uint8Array,
    timestamp: number,
    arrived: number,
    key: boolean,
  ): void {
    if (codec !== this._videoCodec || !this._videoDecoder) {
      void this._videoDecoder?.then((d) => d?.close());
      this._videoCodec = codec;
      this._videoDecoder = videoDecoder(codec);
    }
    // a decoder that falls this far behind starts again at a key frame
    if (this._queued > 8) {
      this._count.framesDropped += 1;
      this._lost();
      return;
    }
    const making = this._videoDecoder;
    const copy = data.slice();
    this._queued += 1;
    this._decoding = this._decoding
      .then(async () => {
        const decoder = await making;
        if (!decoder || this._ended) return;
        const c = this._count;
        const began = performance.now();
        const frames = await decoder.decode(copy);
        const done = performance.now();
        if (frames.length) {
          c.framesDecoded += 1;
          if (key) c.keyFramesDecoded += 1;
          c.totalDecodeTime += (done - began) / 1000;
          c.totalProcessingDelay += (done - arrived) / 1000;
          if (c.lastDecoded) {
            const gap = (done - c.lastDecoded) / 1000;
            c.totalInterFrameDelay += gap;
            c.totalSquaredInterFrameDelay += gap * gap;
          }
          c.lastDecoded = done;
          recent(c.decoded).push(done);
        }
        this._firstTimestamp ??= timestamp;
        const us = Math.round(
          (((timestamp - this._firstTimestamp) >>> 0) * 1000) / 90,
        );
        if (!frames.length) return;
        this._emit(arrived, 1, () => {
          for (const frame of frames) {
            frame.timestamp = us;
            const resized =
              frame.width !== this._size.width ||
              frame.height !== this._size.height;
            this._size = { width: frame.width, height: frame.height };
            const events = this._events;
            if (!events) return;
            if (resized) events.changed?.();
            events.video?.(frame);
          }
        });
      })
      .catch(() => {})
      .finally(() => {
        this._queued -= 1;
      });
  }

  // --- audio --------------------------------------------------------------

  private _audio(rtp: WRtpPacket): void {
    const codec = audioCodecOf(
      this._codecOf(rtp.header.payloadType)?.mimeType ?? '',
    );
    if (!codec) return;
    if (codec !== this._audioCodec || !this._audioDecoder) {
      void this._audioDecoder?.then((d) => d?.close());
      this._audioCodec = codec;
      this._audioDecoder = audioDecoder(codec);
    }
    const making = this._audioDecoder;
    const payload = rtp.payload.slice();
    const arrived = performance.now();
    this._audioChain = this._audioChain
      .then(async () => {
        const decoder = await making;
        if (!decoder || this._ended) return;
        const channels = await decoder.decode(payload);
        if (!channels || !channels.length) return;
        this._channels = channels.length;
        const rate = decoder.sampleRate;
        const c = this._count;
        const rms = rmsOf(channels[0]);
        c.totalSamplesReceived += channels[0].length;
        c.level = rms;
        c.energy += rms * rms * (channels[0].length / rate);
        c.duration += channels[0].length / rate;
        const total = channels[0].length;
        this._emit(arrived, total, () => {
          // 10 ms chunks, as a peer connection's audio frames are
          const per = rate / 100;
          for (let at = 0; at < total; at += per) {
            const frames = Math.min(per, total - at);
            const events = this._events;
            if (!events?.audio) return;
            events.audio({
              sampleRate: rate,
              channels: channels.map((c) => c.subarray(at, at + frames)),
              frames,
              timestamp: Math.round((this._audioTime * 1e6) / rate),
            });
            this._audioTime += frames;
          }
        });
      })
      .catch(() => {});
  }
}
