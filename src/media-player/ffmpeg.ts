// The third backend, and the first that is not a window: an `ffmpeg` child
// process decoding the file to `rawvideo` on a pipe, every frame pushed into
// a core `<video frames>` sink (react-x11 docs/architecture/video.md §8.3).
//
// What that buys is everything `<foreign>` cannot have. The picture is a
// drawn node, in the paint order like an `<image>`: a header scrolls over it,
// a dialog dims it, a transport bar can be a sibling `<box>` laid over it.
// And it needs no XEmbed, so it runs where mpv and VLC cannot be embedded —
// the Wayland backend, the macOS one — and on an X11 desktop with neither
// player installed. What it costs is the audio: a sink is frames, not sound.
//
// The split in this file is the one `./backends.ts` has: the argv and the
// probe's answer are pure functions `test/media-player-ffmpeg.test.ts`
// asserts without an ffmpeg anywhere, and `FramesSession` is the only part
// that runs anything — through `ProcessHost`, so a fake one drives it too.
//
// ### The transport, in signals and restarts
//
// ffmpeg has no control channel worth the name, so the transport is made of
// what a process does have:
//
// - **Pacing is ffmpeg's** (`-re`): it reads the input at its own frame
//   rate, so frames reach the pipe when they are due and the sink shows each
//   on arrival. A sink keeps the newest frame and queues nothing, which is
//   exactly the posture a paced source wants.
// - **Pause is SIGSTOP and play is SIGCONT.** The pipe holds still, the last
//   frame stays on the sink. Measured on ffmpeg 8.1: after a resume `-re`
//   carries on at the frame rate rather than racing to catch up with the
//   wall clock it missed.
// - **Seek is a restart** with `-ss` before `-i` — an input seek, to the
//   keyframe and decoded forward from there. A paused seek shows the new
//   position's first frame and stops again.
// - **Loop is `-stream_loop -1`**, a launch option like mpv's `--loop-file`.
//
// Position is counted, not asked for: frames received since the last
// (re)start, over the probed frame rate, from where that start was.
import type { ExitInfo, ProcessHost, SpawnedProcess } from '../embed/index.js';

/** What a `<video frames>` sink takes. Mirrors react-x11's `VideoFormat`. */
export type FramesFormat = 'NV12' | 'I420' | 'BGRA';
/** Mirrors react-x11's `VideoColorSpace`. */
export type FramesColorSpace = 'bt709' | 'bt601' | 'bt2020';
/** Mirrors react-x11's `VideoRange`. */
export type FramesRange = 'video' | 'full';

/** ffmpeg's name for each sink format. */
const PIX_FMT: Record<FramesFormat, string> = {
  NV12: 'nv12',
  I420: 'yuv420p',
  BGRA: 'bgra',
};

/** The formats this backend can ask ffmpeg for, in react-x11's order. */
export const FRAMES_FORMATS: readonly FramesFormat[] = ['NV12', 'I420', 'BGRA'];

/** The clip, as ffprobe describes its first video stream. */
export interface ProbedClip {
  /** The size frames are decoded to — square pixels, rotation applied, even
   *  on both sides, and `aspectRatio` honoured. */
  width: number;
  height: number;
  colorSpace: FramesColorSpace;
  range: FramesRange;
  /** Frames a second, for counting position. */
  frameRate: number;
  /** Seconds, or 0 where the container does not say — a live stream. */
  duration: number;
}

/** Everything the ffmpeg argv reads. */
export interface FramesLaunch {
  src: string;
  clip: ProbedClip;
  format: FramesFormat;
  /** Seconds into the clip to start from. */
  start?: number;
  loop?: boolean;
  /** Input options, before `-i`: `-hwaccel vaapi` is the one worth having. */
  extraArgs?: readonly string[];
}

/**
 * The input as ffmpeg's `-i` takes it.
 *
 * A URL goes through as it is. Anything else is a path, and gets ffmpeg's
 * `file:` protocol in front, which settles three things at once: a path with
 * a colon in it (`clip:2.mkv`) is not read as a protocol, a lone `-` is not
 * stdin, and a name that starts with a dash is not an option.
 */
export function ffmpegInput(src: string): string {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(src) ? src : `file:${src}`;
}

/** ffprobe's argv: the first video stream's geometry and colour, as JSON. */
export function ffprobeArgs(src: string): string[] {
  return [
    ...['-v', 'error', '-select_streams', 'v:0', '-of', 'json'],
    '-show_entries',
    [
      'stream=width,height,sample_aspect_ratio,color_space,color_range,' +
        'avg_frame_rate,r_frame_rate',
      'stream_side_data=rotation',
      'stream_tags=rotate',
      'format=duration',
    ].join(':'),
    ...['-i', ffmpegInput(src)],
  ];
}

/**
 * ffmpeg's argv: `src` decoded to raw `format` frames on stdout, at the
 * clip's own pace.
 *
 * The scale filter does three jobs: it lands the frames at the probed size
 * (square pixels, the `aspectRatio` override), and for a YCbCr format it
 * names the matrix and range on both sides, so that what reaches the sink is
 * exactly what the sink was told it would be — ffmpeg's default for an
 * untagged stream is BT.601, where the probe's guess for an HD one is 709.
 */
export function ffmpegArgs(launch: FramesLaunch): string[] {
  const { clip, format } = launch;
  const args = ['-v', 'error', '-nostdin'];
  if (launch.start && launch.start > 0) {
    args.push('-ss', launch.start.toFixed(3));
  }
  if (launch.loop) args.push('-stream_loop', '-1');
  args.push('-re');
  if (launch.extraArgs?.length) args.push(...launch.extraArgs);
  args.push('-i', ffmpegInput(launch.src));
  // No audio, subtitles or data: a sink is frames, and a stream nobody
  // reads is a decoder running for nothing.
  args.push('-an', '-sn', '-dn');

  const scale = [`scale=${clip.width}:${clip.height}`];
  scale.push(`in_color_matrix=${clip.colorSpace}`);
  if (format !== 'BGRA') {
    scale.push(`out_color_matrix=${clip.colorSpace}`);
    scale.push(`out_range=${clip.range === 'full' ? 'pc' : 'tv'}`);
  }
  args.push('-vf', scale.join(':'));
  args.push('-pix_fmt', PIX_FMT[format], '-f', 'rawvideo', 'pipe:1');
  return args;
}

/** Bytes in one `format` frame, planes back to back — react-x11's layout,
 *  which is also what ffmpeg's rawvideo muxer writes. */
export function frameBytes(
  format: FramesFormat,
  width: number,
  height: number,
): number {
  if (format === 'BGRA') return width * height * 4;
  return width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
}

/** What ffprobe's JSON is read as. Every field optional: it omits what the
 *  container does not say. */
interface ProbeJson {
  streams?: {
    width?: number;
    height?: number;
    sample_aspect_ratio?: string;
    color_space?: string;
    color_range?: string;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    side_data_list?: { rotation?: number }[];
    tags?: { rotate?: string };
  }[];
  format?: { duration?: string };
}

/** The probe could not describe the clip — no video stream, or not a file
 *  ffmpeg can read. `detail` is ffprobe's own complaint, when it made one. */
export class MediaProbeError extends Error {
  readonly src: string;
  readonly detail: string;

  constructor(src: string, detail: string) {
    super(
      `@react-x11/components: ffprobe could not read a video stream from ` +
        `${src}${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'MediaProbeError';
    this.src = src;
    this.detail = detail;
  }
}

/** `'30000/1001'` → 29.97; anything unusable → NaN. */
function ratio(text: string | undefined): number {
  if (!text) return NaN;
  const [num, den = '1'] = text.split(/[/:]/);
  const value = Number(num) / Number(den);
  return Number.isFinite(value) && value > 0 ? value : NaN;
}

/** The nearest even number, and never below 2: a 4:2:0 frame halves both
 *  sides, and an odd one leaves a chroma row the picture only half covers. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * The colour space a stream's tag names, and a guess where it names none:
 * BT.601 below 720 lines and BT.709 from there, which is what players do and
 * what most untagged files were made assuming.
 */
function colorSpaceOf(
  tag: string | undefined,
  height: number,
): FramesColorSpace {
  switch (tag) {
    case 'bt709':
      return 'bt709';
    case 'bt470bg':
    case 'smpte170m':
    case 'bt601':
      return 'bt601';
    case 'bt2020nc':
    case 'bt2020c':
      return 'bt2020';
    default:
      return height >= 720 ? 'bt709' : 'bt601';
  }
}

/**
 * ffprobe's JSON as the size and colour to decode to.
 *
 * `aspectRatio` is the prop, `'16:9'` or `'1.85'`, and overrides the shape
 * the stream says it has — the width follows from the height, as mpv's
 * `--video-aspect-override` does it.
 */
export function parseProbe(
  json: string,
  src: string,
  aspectRatio?: string,
): ProbedClip {
  let parsed: ProbeJson;
  try {
    parsed = JSON.parse(json) as ProbeJson;
  } catch {
    throw new MediaProbeError(src, 'ffprobe did not answer with JSON');
  }
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream.height) {
    throw new MediaProbeError(src, 'no video stream');
  }

  // Display shape: the stored size stretched by the sample aspect ratio,
  // then turned the way ffmpeg's autorotate will turn it.
  const sar = ratio(stream.sample_aspect_ratio);
  let width = stream.width * (Number.isFinite(sar) ? sar : 1);
  let height = stream.height;
  const rotation =
    stream.side_data_list?.find((d) => typeof d.rotation === 'number')
      ?.rotation ?? Number(stream.tags?.rotate ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const override = ratio(aspectRatio);
  if (Number.isFinite(override)) width = height * override;

  const frameRate = ratio(stream.avg_frame_rate);
  const duration = Number(parsed.format?.duration);
  return {
    width: even(width),
    height: even(height),
    colorSpace: colorSpaceOf(stream.color_space, height),
    range: stream.color_range === 'pc' ? 'full' : 'video',
    frameRate: Number.isFinite(frameRate)
      ? frameRate
      : Number.isFinite(ratio(stream.r_frame_rate))
        ? ratio(stream.r_frame_rate)
        : 30,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
  };
}

/**
 * `chunk => frames`, for a pipe that delivers bytes in whatever pieces it
 * likes — 64 KB at a time, so a 1080p frame is fifty of them.
 *
 * Two buffers, alternated. A sink reads a pushed frame's bytes until the
 * *next* push and does not copy them at the call, so the buffer just pushed
 * cannot be written into; the other one can, because the push before freed
 * it. That is one copy per byte, against the `Buffer.concat` per chunk a
 * naive reader does — quadratic in the chunks a frame spans.
 */
export class FrameReader {
  readonly frameSize: number;
  #onFrame: (frame: Uint8Array) => void;
  #buffers: Uint8Array[] = [];
  #current = 0;
  #filled = 0;

  constructor(frameSize: number, onFrame: (frame: Uint8Array) => void) {
    this.frameSize = frameSize;
    this.#onFrame = onFrame;
  }

  write(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      const target = (this.#buffers[this.#current] ??= new Uint8Array(
        this.frameSize,
      ));
      const n = Math.min(this.frameSize - this.#filled, chunk.length - offset);
      target.set(chunk.subarray(offset, offset + n), this.#filled);
      this.#filled += n;
      offset += n;
      if (this.#filled === this.frameSize) {
        this.#filled = 0;
        this.#current ^= 1;
        this.#onFrame(target);
      }
    }
  }
}

/** Where frames go. react-x11's `VideoFrames` is one. */
export interface FrameSink {
  push(planes: Uint8Array, options?: { time?: number }): void;
}

/** What a session tells the component. */
export interface FramesEvents {
  onProgress?: (info: { position: number; duration: number }) => void;
  onPlayingChange?: (playing: boolean) => void;
  onEnded?: () => void;
  onError?: (err: Error) => void;
  /** ffmpeg ended on its own, other than at the end of the file. */
  onExit?: (info: ExitInfo) => void;
  /** `stop()` ran (true), or the next start after it did (false): whether
   *  the picture should be shown at all. */
  onStopped?: (stopped: boolean) => void;
}

export interface FramesSessionOptions {
  host: ProcessHost;
  /** ffmpeg's path, as `which` found it. */
  command: string;
  launch: Omit<FramesLaunch, 'start'>;
  sink: FrameSink;
  events: FramesEvents;
  /** Sent to end a decoder — at a seek, a stop, and teardown. */
  stopSignal?: string;
}

/** How much of ffmpeg's stderr is kept for an error message. */
const STDERR_TAIL = 2048;

/** Progress is reported this many times per second of playback — HTML's
 *  `timeupdate` pace, so a scrubber costs a render per tick, not per frame. */
const PROGRESS_PER_SECOND = 4;

/** The decoder a session runs: one ffmpeg, and what is known about it. */
interface Decoder {
  child: SpawnedProcess;
  /** Where in the clip it started. */
  start: number;
  /** Frames it has written. */
  frames: number;
  /** Sent SIGSTOP and not yet SIGCONT. */
  stopped: boolean;
  stderr: string;
}

/**
 * One clip, played by a succession of ffmpeg processes: one per start, seek
 * and resume-after-the-end, and never two at once.
 *
 * Every (re)start takes a new generation, and anything a decoder says after
 * its generation has passed — a last frame, its exit — is dropped. That is
 * what makes a seek a restart rather than a race between two processes
 * writing one sink, and what keeps the SIGTERM a seek sends from being
 * reported as ffmpeg failing.
 */
export class FramesSession {
  readonly #options: FramesSessionOptions;
  #decoder: Decoder | null = null;
  /** Between asking the host for a decoder and having one. */
  #spawning = false;
  #generation = 0;
  #paused = false;
  #playing = false;
  #ended = false;
  #idle = false;
  #disposed = false;
  #position = 0;
  #reported = -1;

  constructor(options: FramesSessionOptions) {
    this.#options = options;
  }

  /** Seconds into the clip of the frame on the sink. */
  get position(): number {
    return this.#position;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get pid(): number | null {
    return this.#decoder?.child.pid ?? null;
  }

  /** Begin at `at` seconds — showing that frame and holding it, if
   *  `paused`. */
  start(at = 0, paused = false): void {
    this.#paused = paused;
    void this.#spawn(at);
  }

  setPaused(paused: boolean): void {
    if (this.#disposed) return;
    this.#paused = paused;
    const decoder = this.#decoder;
    if (paused) {
      this.#setPlaying(false);
      // Before the first frame the stop waits for it, so a paused start
      // still has a picture to hold.
      if (decoder && decoder.frames > 0 && !decoder.stopped) {
        decoder.stopped = decoder.child.kill('SIGSTOP');
      }
      return;
    }
    // Played after the end, or after `stop()`: from the top, as HTML's
    // `play()` after `ended` does. After a decoder that failed: from where
    // it stopped, which is a retry.
    if (this.#ended || this.#idle) {
      void this.#spawn(0);
      return;
    }
    if (!decoder && !this.#spawning) {
      void this.#spawn(this.#position);
      return;
    }
    // A decoder still being spawned reads `#paused` when it gets there.
    if (decoder?.stopped) {
      decoder.child.kill('SIGCONT');
      decoder.stopped = false;
    }
    this.#setPlaying(true);
  }

  seek(seconds: number): void {
    if (this.#disposed || !Number.isFinite(seconds)) return;
    const { duration } = this.#options.launch.clip;
    let at = Math.max(0, seconds);
    if (this.#options.launch.loop && duration > 0) at %= duration;
    void this.#spawn(at);
  }

  /** Signal the running decoder. `false` if there is none. */
  signal(signal: string): boolean {
    return this.#decoder?.child.kill(signal) ?? false;
  }

  /** Stop decoding and take the picture down; `play()` starts over. */
  stop(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#end();
    this.#ended = false;
    this.#idle = true;
    this.#position = 0;
    this.#setPlaying(false);
    this.#options.events.onStopped?.(true);
    this.#progress(true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#disposed = true;
    this.#end();
  }

  // --- the decoder ---------------------------------------------------------

  async #spawn(at: number): Promise<void> {
    const generation = ++this.#generation;
    this.#end();
    const { host, command, launch, events } = this.#options;
    if (this.#idle) {
      this.#idle = false;
      events.onStopped?.(false);
    }
    this.#ended = false;
    this.#position = at;
    this.#progress(true);
    if (!this.#paused) this.#setPlaying(true);

    this.#spawning = true;
    let child: SpawnedProcess;
    try {
      child = await host.spawn(command, ffmpegArgs({ ...launch, start: at }), {
        output: true,
      });
    } catch (err) {
      if (generation === this.#generation) {
        this.#spawning = false;
        this.#fail(err);
      }
      return;
    }
    if (generation !== this.#generation) {
      this.#kill(child, false);
      return;
    }
    this.#spawning = false;
    if (!child.onStdout) {
      this.#kill(child, false);
      this.#fail(
        new Error(
          "@react-x11/components: this ProcessHost cannot pipe a child's " +
            'output (`SpawnedProcess.onStdout`), which the ffmpeg backend ' +
            'reads its frames from',
        ),
      );
      return;
    }

    const decoder: Decoder = {
      child,
      start: at,
      frames: 0,
      stopped: false,
      stderr: '',
    };
    this.#decoder = decoder;
    const { clip, format } = launch;
    const reader = new FrameReader(
      frameBytes(format, clip.width, clip.height),
      (frame) => this.#frame(generation, decoder, frame),
    );
    child.onStdout((chunk) => {
      if (generation === this.#generation) reader.write(chunk);
    });
    child.onStderr?.((chunk) => {
      decoder.stderr = (decoder.stderr + text(chunk)).slice(-STDERR_TAIL);
    });
    child.onExit((info) => this.#exited(generation, decoder, info));
    child.onError((err) => {
      if (generation === this.#generation) this.#fail(err);
    });
  }

  #frame(generation: number, decoder: Decoder, frame: Uint8Array): void {
    if (generation !== this.#generation) return;
    decoder.frames += 1;
    const { clip, loop } = this.#options.launch;
    let position = decoder.start + (decoder.frames - 1) / clip.frameRate;
    if (clip.duration > 0) {
      position = loop
        ? position % clip.duration
        : Math.min(position, clip.duration);
    }
    this.#position = position;
    this.#options.sink.push(frame, { time: position });
    this.#progress(false);
    // A paused start, or a pause asked for before there was a picture: now
    // there is one, so hold it.
    if (this.#paused && !decoder.stopped) {
      decoder.stopped = decoder.child.kill('SIGSTOP');
    }
  }

  #exited(generation: number, decoder: Decoder, info: ExitInfo): void {
    if (generation !== this.#generation) return;
    this.#decoder = null;
    this.#setPlaying(false);
    if (info.code === 0) {
      // The end of the file. The last frame stays on the sink, as a
      // player's does.
      this.#ended = true;
      const { duration } = this.#options.launch.clip;
      if (duration > 0) this.#position = duration;
      this.#progress(true);
      this.#options.events.onEnded?.();
      return;
    }
    const detail = decoder.stderr.trim().split('\n').pop() ?? '';
    const how =
      info.signal !== null ? `signal ${info.signal}` : `code ${info.code}`;
    this.#options.events.onError?.(
      new Error(
        `@react-x11/components: ffmpeg exited with ${how}` +
          (detail ? `: ${detail}` : ''),
      ),
    );
    this.#options.events.onExit?.(info);
  }

  #fail(err: unknown): void {
    this.#setPlaying(false);
    this.#options.events.onError?.(
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  /** End the current decoder, if there is one, without hearing about it. */
  #end(): void {
    const decoder = this.#decoder;
    this.#decoder = null;
    // a spawn still in flight is a past generation now, and kills its own
    this.#spawning = false;
    if (decoder) this.#kill(decoder.child, decoder.stopped);
  }

  #kill(child: SpawnedProcess, stopped: boolean): void {
    child.kill(this.#options.stopSignal ?? 'SIGTERM');
    // A stopped process holds a SIGTERM pending until it runs again.
    if (stopped) child.kill('SIGCONT');
  }

  #setPlaying(playing: boolean): void {
    if (this.#playing === playing) return;
    this.#playing = playing;
    this.#options.events.onPlayingChange?.(playing);
  }

  /** `force` for a jump — a seek, the end — and otherwise only when the
   *  position has crossed into the next quarter second. */
  #progress(force: boolean): void {
    const tick = Math.floor(this.#position * PROGRESS_PER_SECOND);
    if (!force && tick === this.#reported) return;
    this.#reported = tick;
    this.#options.events.onProgress?.({
      position: this.#position,
      duration: this.#options.launch.clip.duration,
    });
  }
}

// --- running ffprobe ---------------------------------------------------------

interface DecoderConstructor {
  new (label?: string): { decode(bytes?: Uint8Array): string };
}

const Utf8 = (globalThis as { TextDecoder?: DecoderConstructor }).TextDecoder;

/** Bytes as UTF-8, through the platform's decoder — `src/` has no `Buffer`. */
function text(bytes: Uint8Array): string {
  if (Utf8) return new Utf8('utf-8').decode(bytes);
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Run ffprobe over `src` and answer the clip to decode.
 *
 * Rejects with a `MediaProbeError` carrying ffprobe's last line of stderr —
 * "No such file or directory" is the common one, and the one an app most
 * wants to show.
 */
export async function probeClip(
  host: ProcessHost,
  ffprobe: string,
  src: string,
  aspectRatio?: string,
): Promise<ProbedClip> {
  const child = await host.spawn(ffprobe, ffprobeArgs(src), { output: true });
  if (!child.onStdout) {
    child.kill();
    throw new Error(
      "@react-x11/components: this ProcessHost cannot pipe a child's output " +
        '(`SpawnedProcess.onStdout`), which the ffmpeg backend reads ' +
        "ffprobe's answer from",
    );
  }
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  child.onStdout((chunk) => stdout.push(chunk));
  child.onStderr?.((chunk) => stderr.push(chunk));
  const info = await new Promise<ExitInfo>((resolve, reject) => {
    child.onExit(resolve);
    child.onError(reject);
  });
  if (info.code !== 0) {
    const detail = text(concat(stderr)).trim().split('\n').pop() ?? '';
    throw new MediaProbeError(src, detail);
  }
  return parseProbe(text(concat(stdout)), src, aspectRatio);
}
