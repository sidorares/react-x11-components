// The codecs a page's peer connections send and receive through
// (`src/html/media-codecs.ts`), on the thread they run on: a frame and a
// packet there and back, what a caller handed over still its own, the
// thread ending with its last codec and holding no process open, and the
// page's thread where no thread can be made.
//
// Skipped where libav.js, the optional peer, is not installed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test as nodeTest } from 'node:test';

import {
  audioDecoder,
  audioEncoder,
  codecThreads,
  loadLibAV,
  qualityOf,
  videoDecoder,
  videoEncoder,
} from '../../src/html/media-codecs.js';
import type { MediaVideoFrame } from '../../src/html/media-devices.js';

const libav = await loadLibAV();
const test = libav ? nodeTest : nodeTest.skip;

afterEach(() => {
  codecThreads.entry = 'media-codec-thread';
  codecThreads.pageThread = false;
});

/** A canvas's frame, as a source hands one over: BGRA, a square on a
 *  ground that moves with `n`. */
function canvasFrame(width: number, height: number, n = 0): MediaVideoFrame {
  const bgra = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inside = x >= 8 + n && x < 24 + n && y >= 8 && y < 24;
      bgra[i] = inside ? 255 : 120;
      bgra[i + 1] = inside ? 255 : 80;
      bgra[i + 2] = inside ? 255 : (n * 20) % 255;
      bgra[i + 3] = 255;
    }
  }
  return {
    format: 'BGRA',
    width,
    height,
    planes: [bgra],
    strides: [width * 4],
    timestamp: n * 33_333,
  };
}

/** The mean of an I420 frame's luma inside and outside the square. */
function lumaOf(frame: MediaVideoFrame): { inside: number; outside: number } {
  const [y] = frame.planes;
  const [stride] = frame.strides;
  let inside = 0;
  let outside = 0;
  for (let row = 10; row < 22; row++) inside += y[row * stride + 16];
  for (let row = 30; row < 42; row++) outside += y[row * stride + 50];
  return { inside: inside / 12, outside: outside / 12 };
}

test('VP8 is encoded and decoded on the codecs’ thread, and the frame a caller handed over is still its own', async () => {
  const started = codecThreads.started;
  const encoder = await videoEncoder('VP8');
  const decoder = await videoDecoder('VP8');
  assert.ok(encoder && decoder);
  assert.equal(codecThreads.started, started + 1, 'one thread, for both');
  assert.equal(codecThreads.running, 1);
  assert.equal(codecThreads.pageThread, false);

  const frame = canvasFrame(64, 48);
  const chunks = await encoder.encode(frame, true, 0);
  assert.equal(frame.planes[0].byteLength, 64 * 48 * 4, 'not moved away');
  assert.equal(frame.planes[0][3], 255);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].key, 'the first frame is a key frame');
  assert.ok(chunks[0].data instanceof Uint8Array && chunks[0].data.length > 0);

  const sent = chunks[0].data.slice();
  const pictures = await decoder.decode(chunks[0].data);
  assert.deepEqual(chunks[0].data, sent, 'what was decoded is still there');
  assert.equal(pictures.length, 1);
  const [picture] = pictures;
  assert.equal(picture.format, 'I420');
  assert.equal(picture.width, 64);
  assert.equal(picture.height, 48);
  const luma = lumaOf(picture);
  assert.ok(luma.inside > 200, `white square: ${luma.inside}`);
  assert.ok(luma.outside < 140, `darker ground: ${luma.outside}`);

  // a delta frame after it, the square moved on
  const next = await encoder.encode(canvasFrame(64, 48, 4), false, 3000);
  assert.equal(next.length, 1);
  assert.equal(next[0].key, false);
  assert.equal((await decoder.decode(next[0].data)).length, 1);

  encoder.close();
  assert.equal(codecThreads.running, 1, 'the decoder is still open');
  decoder.close();
  assert.equal(codecThreads.running, 0, 'it ends with its last codec');
  assert.deepEqual(await encoder.encode(frame, true, 0), [], 'closed');
});

test('Opus is encoded and decoded on the codecs’ thread, packets in the order they were asked for', async () => {
  const encoder = await audioEncoder('OPUS');
  const decoder = await audioDecoder('OPUS');
  assert.ok(encoder && decoder);
  assert.equal(encoder.sampleRate, 48000);
  assert.equal(encoder.frameSize, 960);
  assert.equal(decoder.sampleRate, 48000);
  assert.equal(codecThreads.running, 1);

  // five packets of a 440 Hz tone, asked for at once, as a sender asks
  const packets = await Promise.all(
    Array.from({ length: 5 }, (_, p) => {
      const samples = new Float32Array(960);
      for (let i = 0; i < 960; i++) {
        samples[i] =
          0.5 * Math.sin((2 * Math.PI * 440 * (p * 960 + i)) / 48000);
      }
      return encoder.encode(samples);
    }),
  );
  const all = packets.flat();
  assert.equal(all.length, 5);
  let heard = 0;
  for (const packet of all) {
    // libopus answers in two channels where nothing says how many
    const channels: Float32Array[] | null = await decoder.decode(packet);
    assert.ok(channels && channels.length >= 1);
    for (const channel of channels) assert.equal(channel.length, 960);
    heard = Math.max(heard, ...channels[0].map(Math.abs));
  }
  assert.ok(heard > 0.3, `the tone comes back: ${heard}`);
  encoder.close();
  decoder.close();
  assert.equal(codecThreads.running, 0);
});

test('a codec that replaces another keeps the thread, which ends after the last', async () => {
  const started = codecThreads.started;
  const first = await videoEncoder('VP8');
  assert.ok(first);
  // the pipeline closes the old one a microtask after it asks for the new
  const making = videoEncoder('VP9');
  void Promise.resolve().then(() => first.close());
  const second = await making;
  assert.ok(second);
  assert.equal(codecThreads.started, started + 1, 'the same thread');
  const chunks = await second.encode(canvasFrame(64, 48), true, 0);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].key);
  second.close();
  assert.equal(codecThreads.running, 0);
});

test('where no thread can be made, the codecs run on the page’s thread, and come to the same', async () => {
  // a bundle that left the entry behind
  codecThreads.entry = 'no-such-thread';
  const encoder = await videoEncoder('VP8');
  assert.ok(encoder, 'made here');
  assert.equal(codecThreads.pageThread, true);
  assert.equal(codecThreads.running, 0);
  const started = codecThreads.started;
  const decoder = await videoDecoder('VP8');
  assert.ok(decoder);
  assert.equal(codecThreads.started, started, 'and not tried again');
  const chunks = await encoder.encode(canvasFrame(64, 48), true, 0);
  assert.equal(chunks.length, 1);
  const [picture] = await decoder.decode(chunks[0].data);
  assert.equal(picture.width, 64);
  assert.ok(lumaOf(picture).inside > 200);
  encoder.close();
  decoder.close();
});

test('the codecs’ thread holds no process open, with a codec open on it', async (t) => {
  // from the build, as an application runs it: a file, since a worker
  // takes the process's flags, and `--input-type` is no flag a file loads
  // under
  const dir = mkdtempSync(join(tmpdir(), 'codec-thread-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const built = pathToFileURL('dist/html/media-codecs.js').href;
  const script =
    `const m = await import(${JSON.stringify(built)});` +
    "const e = await m.videoEncoder('VP8');" +
    'const p = new Uint8Array(32 * 32 * 4).fill(200);' +
    "const out = await e.encode({ format: 'BGRA', width: 32, height: 32, planes: [p], strides: [128], timestamp: 0 }, true, 0);" +
    "console.log('encoded', out.length, m.codecThreads.running);";
  const file = join(dir, 'encode.mjs');
  writeFileSync(file, script);
  const child = spawn(process.execPath, [file], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d));
  child.stderr.on('data', (d: Buffer) => (out += d));
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 20_000);
    child.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  assert.equal(code, 0, `it should end by itself: ${out}`);
  assert.match(out, /^encoded 1 1$/m);
});

test('a VP8 or VP9 frame comes with its quantizer and its PSNR, on the thread and off it, and a packet with no quality stats with neither', async () => {
  for (const codec of ['VP8', 'VP9'] as const) {
    for (const pageThread of [false, true]) {
      codecThreads.pageThread = pageThread;
      const encoder = await videoEncoder(codec);
      assert.ok(encoder, `a ${codec} encoder`);
      const out = await encoder.encode(canvasFrame(64, 48), true, 0);
      encoder.close();
      assert.equal(out.length, 1);
      const [frame] = out;
      assert.ok(frame.qp !== undefined && frame.qp >= 0, `${codec} qp`);
      const psnr = frame.psnr!;
      for (const plane of [psnr.y, psnr.u, psnr.v]) {
        // a flat ground and a square, coded at a call's bit rate: well
        // above noise, and finite
        assert.ok(Number.isFinite(plane) && plane > 25, `${codec} ${plane}`);
      }
    }
  }
  assert.deepEqual(qualityOf({ side_data: null }, 64, 48), {});
  // a quality of 4 · 118, and the three planes' squared errors
  const stats = new Uint8Array(8 + 24);
  const view = new DataView(stats.buffer);
  view.setUint32(0, 4 * 118, true);
  view.setUint8(5, 3);
  view.setBigUint64(8, 64n * 48n, true);
  view.setBigUint64(16, 0n, true);
  view.setBigUint64(24, 32n * 24n * 100n, true);
  const q = qualityOf({ side_data: [{ type: 8, data: stats }] }, 64, 48);
  assert.equal(q.qp, 4);
  // an error of 1 a sample, none, and 10 a sample
  assert.equal(q.psnr!.y.toFixed(2), (20 * Math.log10(255)).toFixed(2));
  assert.equal(
    q.psnr!.u.toFixed(2),
    (10 * Math.log10(255 * 255 * 32 * 24)).toFixed(2),
  );
  assert.equal(q.psnr!.v.toFixed(2), (20 * Math.log10(25.5)).toFixed(2));
});
