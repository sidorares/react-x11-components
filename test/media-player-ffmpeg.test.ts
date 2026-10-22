// <MediaPlayer backend="ffmpeg">: an ffmpeg child process decoding into a
// core `<video frames>` sink, with the transport made of signals and
// restarts.
//
// Two halves, the way the embedded backends are tested. Everything the
// backend *decides* — when it is chosen, the argv, the probe's reading, what
// a pause or a seek sends to which process — runs against `FakeHost`, which
// is the only way CI with no ffmpeg can assert it. The last tests run a real
// ffmpeg over a clip it has just made, and skip where there is none: those
// are what show the pipe, the frame size and SIGSTOP/SIGCONT hold up against
// the real thing.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import React from 'react';

import { renderX11, cleanup, act, screen, waitFor } from 'react-x11/test';
import type { VideoFrames } from 'react-x11';
import type { Node as RetainedNode } from 'react-x11/node';

import { MediaPlayer, MediaProbeError } from '../src/media-player/index.js';
import type {
  MediaPlayerHandle,
  MediaProgress,
} from '../src/media-player/index.js';
import {
  FrameReader,
  ffmpegArgs,
  ffmpegInput,
  frameBytes,
  parseProbe,
} from '../src/media-player/ffmpeg.js';
import type { ProbedClip } from '../src/media-player/ffmpeg.js';
import { nodeProcessHost } from '../src/embed/index.js';
import type { ExitInfo, SpawnedProcess } from '../src/embed/index.js';
import { cocoaShapedApp } from './cocoa-shaped.js';
import { FakeHost } from './fake-host.js';
import type { FakeProcess } from './fake-host.js';

const h = React.createElement;

afterEach(cleanup);

// --- the argv and the probe ------------------------------------------------

const CLIP: ProbedClip = {
  width: 1280,
  height: 720,
  colorSpace: 'bt709',
  range: 'video',
  frameRate: 25,
  duration: 60,
};

test('ffmpeg is asked for raw frames on stdout, at the clip pace', () => {
  const args = ffmpegArgs({ src: '/v.mkv', clip: CLIP, format: 'NV12' });
  assert.deepStrictEqual(
    args.slice(args.indexOf('-i'), args.indexOf('-i') + 2),
    ['-i', 'file:/v.mkv'],
  );
  assert.ok(args.indexOf('-re') < args.indexOf('-i'), '-re is an input option');
  for (const flag of ['-an', '-sn', '-dn']) assert.ok(args.includes(flag));
  assert.strictEqual(
    args[args.indexOf('-vf') + 1],
    'scale=1280:720:in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv',
  );
  assert.deepStrictEqual(args.slice(-5), [
    '-pix_fmt',
    'nv12',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  assert.ok(!args.includes('-ss'), 'from the start, no seek');
  assert.ok(!args.includes('-stream_loop'));
});

test('a seek, a loop and extraArgs all go before the input', () => {
  const args = ffmpegArgs({
    src: '/v.mkv',
    clip: CLIP,
    format: 'I420',
    start: 12.5,
    loop: true,
    extraArgs: ['-hwaccel', 'vaapi'],
  });
  const input = args.indexOf('-i');
  assert.strictEqual(args[args.indexOf('-ss') + 1], '12.500');
  assert.strictEqual(args[args.indexOf('-stream_loop') + 1], '-1');
  for (const flag of ['-ss', '-stream_loop', '-hwaccel']) {
    assert.ok(args.indexOf(flag) < input, `${flag} before -i`);
  }
  assert.strictEqual(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
});

test('BGRA names the input matrix only: RGB has no range to set', () => {
  const args = ffmpegArgs({
    src: '/v.mkv',
    clip: { ...CLIP, colorSpace: 'bt601', range: 'full' },
    format: 'BGRA',
  });
  assert.strictEqual(
    args[args.indexOf('-vf') + 1],
    'scale=1280:720:in_color_matrix=bt601',
  );
  assert.strictEqual(args[args.indexOf('-pix_fmt') + 1], 'bgra');
});

test('a path is a file: input, and a URL is left alone', () => {
  assert.strictEqual(ffmpegInput('/a/b.mkv'), 'file:/a/b.mkv');
  // a colon in a name is not a protocol, a dash is not an option, and a
  // lone dash is not stdin
  assert.strictEqual(ffmpegInput('clip:2.mkv'), 'file:clip:2.mkv');
  assert.strictEqual(ffmpegInput('-v.mkv'), 'file:-v.mkv');
  assert.strictEqual(ffmpegInput('-'), 'file:-');
  assert.strictEqual(
    ffmpegInput('https://example.com/a.m3u8'),
    'https://example.com/a.m3u8',
  );
});

/** ffprobe's answer for one stream. */
function probeJson(
  stream: Record<string, unknown>,
  duration: string = '3.000000',
): string {
  return JSON.stringify({ streams: [stream], format: { duration } });
}

test('the probe reads size, colour, rate and duration', () => {
  const clip = parseProbe(
    probeJson(
      {
        width: 1920,
        height: 1080,
        color_space: 'bt709',
        color_range: 'pc',
        avg_frame_rate: '30000/1001',
      },
      '12.5',
    ),
    '/v.mkv',
  );
  assert.strictEqual(clip.width, 1920);
  assert.strictEqual(clip.height, 1080);
  assert.strictEqual(clip.colorSpace, 'bt709');
  assert.strictEqual(clip.range, 'full');
  assert.ok(Math.abs(clip.frameRate - 29.97) < 0.01);
  assert.strictEqual(clip.duration, 12.5);
});

test('an untagged stream is BT.601 below 720 lines and BT.709 from there', () => {
  const sd = parseProbe(probeJson({ width: 640, height: 480 }), '/v');
  const hd = parseProbe(probeJson({ width: 1280, height: 720 }), '/v');
  assert.strictEqual(sd.colorSpace, 'bt601');
  assert.strictEqual(hd.colorSpace, 'bt709');
  assert.strictEqual(sd.range, 'video');
  for (const tag of ['bt470bg', 'smpte170m']) {
    const clip = parseProbe(
      probeJson({ width: 1920, height: 1080, color_space: tag }),
      '/v',
    );
    assert.strictEqual(clip.colorSpace, 'bt601', tag);
  }
});

test('the frame is square-pixelled, turned, reshaped and even', () => {
  // DVD 16:9: 720x480 stored, 32:27 pixels
  const dvd = parseProbe(
    probeJson({ width: 720, height: 480, sample_aspect_ratio: '32:27' }),
    '/v',
  );
  assert.deepStrictEqual([dvd.width, dvd.height], [854, 480]);

  // a phone held upright: ffmpeg's autorotate turns it, so the sink must be
  // made the turned way round — from either place a rotation is recorded
  const side = parseProbe(
    probeJson({
      width: 1920,
      height: 1080,
      side_data_list: [{ rotation: -90 }],
    }),
    '/v',
  );
  assert.deepStrictEqual([side.width, side.height], [1080, 1920]);
  const tag = parseProbe(
    probeJson({ width: 1920, height: 1080, tags: { rotate: '270' } }),
    '/v',
  );
  assert.deepStrictEqual([tag.width, tag.height], [1080, 1920]);

  const forced = parseProbe(
    probeJson({ width: 1920, height: 1080 }),
    '/v',
    '4:3',
  );
  assert.deepStrictEqual([forced.width, forced.height], [1440, 1080]);

  const odd = parseProbe(probeJson({ width: 641, height: 361 }), '/v');
  assert.deepStrictEqual([odd.width % 2, odd.height % 2], [0, 0]);
});

test('what the probe cannot use is a MediaProbeError or a default', () => {
  assert.throws(() => parseProbe('nope', '/v'), MediaProbeError);
  assert.throws(
    () => parseProbe(JSON.stringify({ streams: [] }), '/v'),
    /no video stream/,
  );
  // a live stream has no duration, and a stream with no average rate has
  // its real base rate
  const live = parseProbe(
    probeJson({ width: 64, height: 36, r_frame_rate: '50/1' }, 'N/A'),
    '/v',
  );
  assert.strictEqual(live.duration, 0);
  assert.strictEqual(live.frameRate, 50);
});

test('frame sizes follow the sink layout, odd sides rounded up', () => {
  assert.strictEqual(frameBytes('NV12', 4, 2), 8 + 4);
  assert.strictEqual(frameBytes('I420', 4, 2), 8 + 4);
  assert.strictEqual(frameBytes('BGRA', 4, 2), 32);
  assert.strictEqual(frameBytes('NV12', 3, 3), 9 + 2 * 2 * 2);
});

test('frames are cut from the pipe however it is chunked, in two buffers', () => {
  const frames: Uint8Array[] = [];
  const copies: number[][] = [];
  const reader = new FrameReader(4, (frame) => {
    frames.push(frame);
    copies.push([...frame]);
  });
  reader.write(Uint8Array.of(1, 1));
  assert.strictEqual(frames.length, 0, 'half a frame is not a frame');
  reader.write(Uint8Array.of(1, 1, 2, 2, 2, 2, 3));
  reader.write(Uint8Array.of(3, 3, 3));
  assert.deepStrictEqual(copies, [
    [1, 1, 1, 1],
    [2, 2, 2, 2],
    [3, 3, 3, 3],
  ]);
  // the frame just pushed is never the one being filled; the one before is
  assert.notStrictEqual(frames[0], frames[1]);
  assert.strictEqual(frames[0], frames[2]);
});

// --- the component, over a fake host ---------------------------------------

const PROBED = probeJson(
  {
    width: 64,
    height: 36,
    color_space: 'bt709',
    color_range: 'tv',
    avg_frame_rate: '10/1',
  },
  '3.000000',
);
/** The mock backend's sink is BGRA: it has no `videoFormats`. */
const FRAME_BYTES = 64 * 36 * 4;

function frame(fill: number): Uint8Array {
  return new Uint8Array(FRAME_BYTES).fill(fill);
}

/** A host with ffmpeg and ffprobe "installed", whose ffprobe answers. */
function ffmpegHost(
  installed: readonly string[] = ['ffmpeg', 'ffprobe'],
  probe: string = PROBED,
): FakeHost {
  const host = new FakeHost({ installed });
  host.script('ffprobe', ({ process }) => {
    process.stdout(probe);
    process.exit({ code: 0, signal: null });
  });
  return host;
}

function videoNode(): RetainedNode | undefined {
  const [node] = screen.all(
    (n) => (n as unknown as RetainedNode).kind === 'video',
  );
  return node as unknown as RetainedNode | undefined;
}

function sink(): VideoFrames | undefined {
  return videoNode()?.props.frames as VideoFrames | undefined;
}

function foreignNode(): unknown {
  return screen.all(
    (n) => (n as unknown as RetainedNode).kind === 'foreign',
  )[0];
}

interface Mounted {
  host: FakeHost;
  ref: React.RefObject<MediaPlayerHandle | null>;
  /** The newest ffmpeg. */
  ffmpeg: () => FakeProcess;
  /** Every ffmpeg's argv, in order. */
  argv: () => string[][];
  rerender: (props?: Record<string, unknown>) => Promise<void>;
}

async function mountFrames(
  props: Record<string, unknown> = {},
  host: FakeHost = ffmpegHost(),
): Promise<Mounted> {
  const ref = React.createRef<MediaPlayerHandle>();
  const base = { processes: host, src: '/a.mkv', ref };
  const { rerender } = await renderX11(h(MediaPlayer, { ...base, ...props }), {
    backend: 'mock',
  });
  await waitFor(() => assert.strictEqual(host.spawnsOf('ffmpeg').length, 1));
  return {
    host,
    ref,
    ffmpeg: () => host.spawnsOf('ffmpeg').at(-1)!.process,
    argv: () => host.spawnsOf('ffmpeg').map((s) => s.args),
    rerender: async (next = {}) => {
      await rerender(h(MediaPlayer, { ...base, ...next }));
    },
  };
}

test("'auto' on an app that cannot embed goes to ffmpeg, without looking for mpv", async () => {
  // The Cocoa backend's shape. mpv is installed, and would be the wrong
  // answer: there is no window to hand it.
  const host = ffmpegHost(['mpv', 'ffmpeg', 'ffprobe']);
  const ref = React.createRef<MediaPlayerHandle>();
  await renderX11(h(MediaPlayer, { processes: host, src: '/a.mkv', ref }), {
    app: cocoaShapedApp(),
    backend: 'mock',
  });
  await waitFor(() => assert.strictEqual(host.spawnsOf('ffmpeg').length, 1));

  assert.deepStrictEqual(host.probed, ['ffmpeg', 'ffprobe']);
  const [probe] = host.spawnsOf('ffprobe');
  assert.ok(probe!.args.includes('file:/a.mkv'));
  assert.strictEqual(probe!.options.output, true, 'its answer is read');
  const [decoder] = host.spawnsOf('ffmpeg');
  assert.strictEqual(decoder!.options.output, true);
  assert.strictEqual(
    decoder!.args[decoder!.args.indexOf('-pix_fmt') + 1],
    'bgra',
  );

  // a drawn <video> with a sink of the probed size, and no <foreign>
  assert.strictEqual(foreignNode(), undefined);
  assert.strictEqual(sink()?.width, 64);
  assert.strictEqual(sink()?.height, 36);
  assert.strictEqual(sink()?.format, 'BGRA');
  assert.strictEqual(ref.current!.backend, 'ffmpeg');
  assert.strictEqual(ref.current!.windowId, null);
  assert.strictEqual(ref.current!.reportsProgress, true);
  assert.strictEqual(videoNode()?.props.focusable, false);
});

test("'auto' on X11 with neither player installed falls through to ffmpeg", async () => {
  const host = ffmpegHost();
  await renderX11(h(MediaPlayer, { processes: host, src: '/a.mkv' }), {
    backend: 'xserver',
  });
  await waitFor(() => assert.strictEqual(host.spawnsOf('ffmpeg').length, 1));
  assert.deepStrictEqual(host.probed.slice(0, 2), ['mpv', 'vlc']);
  assert.strictEqual(foreignNode(), undefined);
  assert.ok(videoNode(), 'the surface is a <video>');
});

test("backend='ffmpeg' is ffmpeg even where mpv could be embedded", async () => {
  const host = ffmpegHost(['mpv', 'ffmpeg', 'ffprobe']);
  await renderX11(
    h(MediaPlayer, { processes: host, src: '/a.mkv', backend: 'ffmpeg' }),
    { backend: 'xserver' },
  );
  await waitFor(() => assert.strictEqual(host.spawnsOf('ffmpeg').length, 1));
  assert.ok(!host.probed.includes('mpv'), 'mpv was never looked for');
  assert.strictEqual(host.spawnsOf('mpv').length, 0);
  assert.strictEqual(foreignNode(), undefined);
});

test('no ffmpeg is unavailable, with the fallback', async () => {
  const host = ffmpegHost(['ffprobe']);
  const errors: Error[] = [];
  const ref = React.createRef<MediaPlayerHandle>();
  await renderX11(
    h(MediaPlayer, {
      processes: host,
      src: '/a.mkv',
      ref,
      onError: (err: Error) => errors.push(err),
      fallback: h('text', { 'data-testname': 'no-player' }, 'install ffmpeg'),
    }),
    { backend: 'mock' },
  );
  await waitFor(() => assert.ok(screen.getByTestName('no-player')));
  assert.strictEqual(ref.current!.status, 'unavailable');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0]!.message, /looked for ffmpeg\./);
  assert.strictEqual(host.spawns.length, 0);
  assert.strictEqual(videoNode(), undefined);
});

test('stdout becomes frames on the sink, however the pipe chunks it', async () => {
  const { ffmpeg } = await mountFrames();
  const bytes = new Uint8Array(FRAME_BYTES * 2);
  bytes.fill(7, 0, FRAME_BYTES);
  bytes.fill(9, FRAME_BYTES);

  await act(() => ffmpeg().stdout(bytes.subarray(0, 1000)));
  assert.strictEqual(sink()!.version, 0, 'not a whole frame yet');
  await act(() => ffmpeg().stdout(bytes.subarray(1000, FRAME_BYTES + 5)));
  assert.strictEqual(sink()!.version, 1);
  assert.strictEqual(sink()!.frame!.planes[0]![0], 7);
  await act(() => ffmpeg().stdout(bytes.subarray(FRAME_BYTES + 5)));
  assert.strictEqual(sink()!.version, 2);
  assert.strictEqual(sink()!.frame!.planes[0]![FRAME_BYTES - 1], 9);
});

test('position is frames over the probed rate, a few times a second', async () => {
  const progress: MediaProgress[] = [];
  const { ffmpeg } = await mountFrames({
    onProgress: (p: MediaProgress) => progress.push(p),
  });
  for (let i = 0; i < 6; i++) await act(() => ffmpeg().stdout(frame(i)));
  // the start, then the frame that crosses each quarter second at 10 fps —
  // 0.3s and 0.5s — and nothing for the frames between
  assert.deepStrictEqual(
    progress.map((p) => [Math.round(p.position * 10) / 10, p.duration]),
    [
      [0, 3],
      [0.3, 3],
      [0.5, 3],
    ],
  );
  assert.ok(
    Math.abs(sink()!.frame!.time! - 0.5) < 1e-9,
    'pushed with its time',
  );
});

test('pause is SIGSTOP and play is SIGCONT, to the same process', async () => {
  const playing: boolean[] = [];
  const { ffmpeg, ref, host } = await mountFrames({
    onPlayingChange: (p: boolean) => playing.push(p),
  });
  await act(() => ffmpeg().stdout(frame(1)));

  ref.current!.pause();
  ref.current!.play();
  assert.deepStrictEqual(ffmpeg().signals, ['SIGSTOP', 'SIGCONT']);
  assert.deepStrictEqual(playing, [true, false, true]);
  assert.strictEqual(host.spawnsOf('ffmpeg').length, 1, 'no restart');
});

test('a paused start shows its first frame and then holds it', async () => {
  const { ffmpeg, ref } = await mountFrames({ autoPlay: false });
  // no picture yet, so nothing to hold: the stop waits for one
  assert.deepStrictEqual(ffmpeg().signals, []);
  await act(() => ffmpeg().stdout(frame(1)));
  assert.deepStrictEqual(ffmpeg().signals, ['SIGSTOP']);
  assert.strictEqual(sink()!.version, 1);

  ref.current!.play();
  assert.deepStrictEqual(ffmpeg().signals, ['SIGSTOP', 'SIGCONT']);
});

test('the paused prop drives the same signals', async () => {
  const { ffmpeg, rerender } = await mountFrames({ paused: false });
  await act(() => ffmpeg().stdout(frame(1)));
  await rerender({ paused: true });
  await rerender({ paused: false });
  assert.deepStrictEqual(ffmpeg().signals, ['SIGSTOP', 'SIGCONT']);
});

test('a seek is a restart at -ss, and a paused one stays paused', async () => {
  const progress: MediaProgress[] = [];
  const errors: Error[] = [];
  const { ffmpeg, ref, argv, host } = await mountFrames({
    onProgress: (p: MediaProgress) => progress.push(p),
    onError: (err: Error) => errors.push(err),
  });
  const first = ffmpeg();
  await act(() => first.stdout(frame(1)));

  ref.current!.seek(1.5);
  await waitFor(() => assert.strictEqual(host.spawnsOf('ffmpeg').length, 2));
  assert.deepStrictEqual(first.signals, ['SIGTERM']);
  const second = argv()[1]!;
  assert.strictEqual(second[second.indexOf('-ss') + 1], '1.500');
  assert.strictEqual(progress.at(-1)!.position, 1.5, 'reported at once');

  // paused: the stopped decoder needs a SIGCONT to act on its SIGTERM, and
  // the new one holds its first frame
  const decoder = ffmpeg();
  await act(() => decoder.stdout(frame(2)));
  ref.current!.pause();
  ref.current!.seek(2);
  await waitFor(() => assert.strictEqual(host.spawnsOf('ffmpeg').length, 3));
  assert.deepStrictEqual(decoder.signals, ['SIGSTOP', 'SIGTERM', 'SIGCONT']);
  await act(() => ffmpeg().stdout(frame(3)));
  assert.deepStrictEqual(ffmpeg().signals, ['SIGSTOP']);

  // the killed decoder's late frames and exit are no longer news
  await act(() => {
    first.stdout(frame(4));
    first.exit({ code: 255, signal: null });
  });
  assert.strictEqual(sink()!.frame!.planes[0]![0], 3);
  assert.strictEqual(errors.length, 0);
});

test('a seek past the end of a looped clip wraps', async () => {
  const { ref, argv, host } = await mountFrames({ loop: true });
  assert.strictEqual(argv()[0]![argv()[0]!.indexOf('-stream_loop') + 1], '-1');
  ref.current!.seek(7);
  await waitFor(() => assert.strictEqual(host.spawnsOf('ffmpeg').length, 2));
  const args = argv()[1]!;
  assert.strictEqual(args[args.indexOf('-ss') + 1], '1.000');
});

test('the end of the file is onEnded, and play() starts over', async () => {
  let ended = 0;
  const exits: ExitInfo[] = [];
  const playing: boolean[] = [];
  const { ffmpeg, ref, argv, host } = await mountFrames({
    onEnded: () => (ended += 1),
    onExit: (info: ExitInfo) => exits.push(info),
    onPlayingChange: (p: boolean) => playing.push(p),
  });
  await act(() => ffmpeg().stdout(frame(1)));
  await act(() => ffmpeg().exit({ code: 0, signal: null }));

  assert.strictEqual(ended, 1);
  assert.deepStrictEqual(exits, [], 'the end of a file is not a crash');
  assert.deepStrictEqual(playing, [true, false]);
  assert.strictEqual(sink()!.version, 1, 'the last frame stays up');
  assert.strictEqual(ref.current!.status, 'running');

  ref.current!.play();
  await waitFor(() => assert.strictEqual(host.spawnsOf('ffmpeg').length, 2));
  assert.ok(!argv()[1]!.includes('-ss'), 'from the top');
});

test('ffmpeg failing is onError with its own words, and onExit', async () => {
  const errors: Error[] = [];
  const exits: ExitInfo[] = [];
  const { ffmpeg, ref } = await mountFrames({
    onError: (err: Error) => errors.push(err),
    onExit: (info: ExitInfo) => exits.push(info),
  });
  await act(() => {
    ffmpeg().stderr('[in#0] Error opening input\n/a.mkv: Invalid data found\n');
    ffmpeg().exit({ code: 1, signal: null });
  });
  assert.strictEqual(errors.length, 1);
  assert.match(
    errors[0]!.message,
    /ffmpeg exited with code 1: \/a\.mkv: Invalid data found/,
  );
  assert.deepStrictEqual(exits, [{ code: 1, signal: null }]);
  assert.strictEqual(ref.current!.status, 'exited');
});

test('a file ffprobe cannot read is a MediaProbeError, and nothing decodes', async () => {
  const host = new FakeHost({ installed: ['ffmpeg', 'ffprobe'] });
  host.script('ffprobe', ({ process }) => {
    process.stderr('/a.mkv: No such file or directory\n');
    process.exit({ code: 1, signal: null });
  });
  const errors: Error[] = [];
  const ref = React.createRef<MediaPlayerHandle>();
  await renderX11(
    h(MediaPlayer, {
      processes: host,
      src: '/a.mkv',
      ref,
      onError: (err: Error) => errors.push(err),
    }),
    { backend: 'mock' },
  );
  await waitFor(() => assert.strictEqual(errors.length, 1));
  assert.ok(errors[0] instanceof MediaProbeError);
  assert.match(errors[0]!.message, /No such file or directory/);
  assert.strictEqual(ref.current!.status, 'exited');
  assert.strictEqual(host.spawnsOf('ffmpeg').length, 0);
});

test('a new src is probed and decoded, keeping the pause', async () => {
  const { ffmpeg, ref, rerender, host, argv } = await mountFrames();
  const first = ffmpeg();
  await act(() => first.stdout(frame(1)));
  ref.current!.pause();

  await rerender({ src: '/b.mkv' });
  await waitFor(() => assert.strictEqual(host.spawnsOf('ffmpeg').length, 2));
  assert.strictEqual(host.spawnsOf('ffprobe').length, 2);
  assert.ok(argv()[1]!.includes('file:/b.mkv'));
  assert.deepStrictEqual(first.signals, ['SIGSTOP', 'SIGTERM', 'SIGCONT']);
  await act(() => ffmpeg().stdout(frame(2)));
  assert.deepStrictEqual(ffmpeg().signals, ['SIGSTOP'], 'still paused');
});

test('volume and muted change nothing: the backend is silent', async () => {
  const { host, rerender } = await mountFrames({ volume: 0.5 });
  await rerender({ volume: 0.2, muted: true });
  await act();
  assert.strictEqual(host.spawnsOf('ffmpeg').length, 1);
  assert.strictEqual(host.spawnsOf('ffprobe').length, 1);
});

test('stop() takes the picture down, and play() starts over', async () => {
  const { ffmpeg, ref, argv, host } = await mountFrames();
  const first = ffmpeg();
  await act(() => first.stdout(frame(1)));

  await act(() => ref.current!.stop());
  assert.deepStrictEqual(first.signals, ['SIGTERM']);
  assert.strictEqual(videoNode()?.props.frames, undefined);

  await act(() => ref.current!.play());
  await waitFor(() => assert.strictEqual(host.spawnsOf('ffmpeg').length, 2));
  assert.ok(!argv()[1]!.includes('-ss'));
  assert.ok(videoNode()?.props.frames, 'the sink is shown again');
});

test('unmounting ends the decoder, paused or not', async () => {
  const { ffmpeg, ref } = await mountFrames();
  await act(() => ffmpeg().stdout(frame(1)));
  ref.current!.pause();
  const decoder = ffmpeg();
  await cleanup();
  // a stopped process holds a SIGTERM until it runs again
  assert.deepStrictEqual(decoder.signals, ['SIGSTOP', 'SIGTERM', 'SIGCONT']);
});

test('a ProcessHost that cannot pipe output is told so', async () => {
  // A host written against the interface before `output` existed.
  class Mute extends FakeHost {
    override async spawn(
      command: string,
      args: readonly string[],
    ): Promise<SpawnedProcess> {
      const child = (await super.spawn(command, args)) as FakeProcess;
      return {
        pid: child.pid,
        kill: (sig?: string) => child.kill(sig),
        onExit: (l) => child.onExit(l),
        onError: (l) => child.onError(l),
      };
    }
  }
  const host = new Mute({ installed: ['ffmpeg', 'ffprobe'] });
  const errors: Error[] = [];
  await renderX11(
    h(MediaPlayer, {
      processes: host,
      src: '/a.mkv',
      onError: (err: Error) => errors.push(err),
    }),
    { backend: 'mock' },
  );
  await waitFor(() => assert.strictEqual(errors.length, 1));
  assert.match(errors[0]!.message, /cannot pipe a child's output/);
  assert.deepStrictEqual(host.spawns[0]!.process.signals, ['SIGTERM']);
});

// --- a real ffmpeg ------------------------------------------------------------

const real = nodeProcessHost();
const tools = await Promise.all([real.which('ffmpeg'), real.which('ffprobe')]);
const noFfmpeg = tools.includes(null)
  ? 'needs ffmpeg and ffprobe on PATH'
  : false;

/** A clip of one flat colour, made by the ffmpeg under test. */
function makeClip(dir: string, seconds: number): string {
  const file = path.join(dir, 'red.mkv');
  execFileSync('ffmpeg', [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=64x48:rate=10'],
    ...['-t', String(seconds), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', file],
  ]);
  return file;
}

test(
  'a real ffmpeg plays a real clip into the sink, to the end',
  { skip: noFfmpeg },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'react-x11-ffmpeg-'));
    try {
      const src = makeClip(dir, 1);
      let ended = 0;
      const progress: MediaProgress[] = [];
      const errors: Error[] = [];
      await renderX11(
        h(MediaPlayer, {
          src,
          backend: 'ffmpeg',
          onEnded: () => (ended += 1),
          onProgress: (p: MediaProgress) => progress.push(p),
          onError: (err: Error) => errors.push(err),
        }),
        { backend: 'mock' },
      );
      await waitFor(() => assert.strictEqual(ended, 1), { timeout: 10_000 });

      assert.deepStrictEqual(errors, []);
      const frames = sink()!;
      assert.deepStrictEqual([frames.width, frames.height], [64, 48]);
      assert.strictEqual(frames.version, 10, 'one second at 10 fps');
      // red, through BT.601 and back: BGRA
      const [b, g, r] = frames.frame!.planes[0]!;
      assert.ok(r! > 240 && g! < 16 && b! < 16, `got ${[b, g, r]}`);
      assert.ok(Math.abs(progress.at(-1)!.position - 1) < 0.05);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'a real ffmpeg holds still under pause and carries on after',
  { skip: noFfmpeg },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'react-x11-ffmpeg-'));
    try {
      const src = makeClip(dir, 2);
      let ended = 0;
      const ref = React.createRef<MediaPlayerHandle>();
      await renderX11(
        h(MediaPlayer, {
          src,
          ref,
          backend: 'ffmpeg',
          onEnded: () => (ended += 1),
        }),
        { backend: 'mock' },
      );
      await waitFor(() => assert.ok(sink()!.version >= 3), { timeout: 10_000 });
      ref.current!.pause();
      // what was already in the pipe may still land; then nothing does
      await new Promise((resolve) => setTimeout(resolve, 200));
      const held = sink()!.version;
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.strictEqual(sink()!.version, held, 'no frames while stopped');

      ref.current!.play();
      await waitFor(() => assert.strictEqual(ended, 1), { timeout: 10_000 });
      // every frame, once: a resume is the same decoder carrying on, not a
      // restart that shows the first ones again
      assert.strictEqual(sink()!.version, 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
