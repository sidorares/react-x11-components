// A page's VP9 on its way to the platform's player: read out of the WebM it
// was appended as (`webm.ts`), kept by the host (`clips.ts`) and written as an
// MP4 (`mp4.ts`). The bytes of each sample are the point: nothing is decoded,
// so what a player is handed has to be what the page appended, in the tables
// AVFoundation reads. `webmStream` and `sampleOf` are what a page's test
// appends too (`scripts.test.ts`).
import assert from 'node:assert/strict';
import test from 'node:test';

import { VideoClips } from '../../src/html/scripts/clips.js';
import { vp9Frame, vp9Mp4 } from '../../src/html/scripts/mp4.js';
import { WebmReader } from '../../src/html/scripts/webm.js';
import { sampleOf, webmStream } from '../webm-fixture.js';

function readWhole(bytes: Uint8Array, chunk = bytes.length) {
  const reader = new WebmReader();
  const packets = [];
  for (let at = 0; at < bytes.length; at += chunk) {
    packets.push(...reader.push(bytes.subarray(at, at + chunk)));
  }
  return { reader, packets };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

test("a stream's track, length and packets are read wherever its chunks were cut", () => {
  const { bytes, frames } = webmStream({ count: 12, every: 4 });
  const whole = readWhole(bytes);
  assert.equal(whole.reader.failed, false);
  assert.deepEqual(whole.reader.video, {
    width: 320,
    height: 180,
    colour: { matrix: 1, range: 1, transfer: 13, primaries: 1 },
  });
  assert.equal(whole.reader.duration, 0.4);
  assert.deepEqual(
    whole.packets.map((p) => [p.time, hex(p.data)]),
    frames.map((f) => [f.time, hex(f.data)]),
  );
  // a fetch hands a page whatever arrived: in the middle of an id, a size,
  // a block's head or its bytes
  for (let chunk = 1; chunk <= 40; chunk += 1) {
    const cut = readWhole(bytes, chunk);
    assert.equal(cut.reader.failed, false, `cut every ${chunk}`);
    assert.deepEqual(
      cut.reader.video,
      whole.reader.video,
      `cut every ${chunk}`,
    );
    assert.deepEqual(
      cut.packets.map((p) => hex(p.data)),
      frames.map((f) => hex(f.data)),
      `cut every ${chunk}`,
    );
  }
});

test('masters of no stated size are walked into, as a muxer writing to a pipe has them', () => {
  const { bytes, frames } = webmStream({ count: 6, unknownSizes: true });
  const { reader, packets } = readWhole(bytes, 7);
  assert.equal(reader.failed, false);
  assert.equal(packets.length, frames.length);
});

test("a block group's blocks are the track's too, as Apple's clips write them", () => {
  const { bytes, frames } = webmStream({ count: 6, groups: true });
  const { packets } = readWhole(bytes);
  assert.deepEqual(
    packets.map((p) => hex(p.data)),
    frames.map((f) => hex(f.data)),
  );
});

test('an audio track beside the video is passed over', () => {
  const { bytes, frames } = webmStream({ count: 4, audio: true });
  const { reader, packets } = readWhole(bytes);
  assert.equal(reader.failed, false);
  assert.equal(packets.length, frames.length);
});

test('what is no WebM, and WebM of no VP9, are not read', () => {
  assert.equal(readWhole(new Uint8Array(64).fill(7)).reader.failed, true);
  const vp8 = webmStream({ count: 2, codec: 'V_VP8' }).bytes;
  assert.equal(readWhole(vp8).reader.failed, true);
  const laced = webmStream({ count: 2, lacing: true }).bytes;
  assert.equal(readWhole(laced).reader.failed, true);
});

test("VP9's own header says what is a key frame, and what a stream is", () => {
  const key = vp9Frame(sampleOf(0, true));
  assert.equal(key.key, true);
  assert.deepEqual(key.config, {
    profile: 0,
    bitDepth: 8,
    chroma: 1,
    fullRange: false,
    matrix: 1,
  });
  assert.deepEqual(vp9Frame(sampleOf(1, false)), { key: false, config: null });
  // a shown earlier frame is no key frame, whatever follows its flag
  assert.equal(vp9Frame(new Uint8Array([0b10001000, 0, 0])).key, false);
  // and no frame marker is no frame
  assert.equal(vp9Frame(new Uint8Array([0, 0, 0])).key, false);
  // profile 1 says its own subsampling
  const p1 = vp9Frame(
    new Uint8Array([0b10100010, 0x49, 0x83, 0x42, 0b01000100, 0]),
  );
  assert.deepEqual(p1.config, {
    profile: 1,
    bitDepth: 8,
    chroma: 3,
    fullRange: false,
    matrix: 1,
  });
  // sRGB is full range and 4:4:4, and says neither
  const srgb = vp9Frame(
    new Uint8Array([0b10100010, 0x49, 0x83, 0x42, 0xe0, 0]),
  );
  assert.equal(srgb.config?.chroma, 3);
  assert.equal(srgb.config?.fullRange, true);
  assert.equal(srgb.config?.matrix, 0);
});

/** An MP4's boxes by type, with their nested paths: `moov/trak/…`. */
function boxesOf(
  file: Uint8Array,
  from = 0,
  to = file.length,
  path = '',
  out = new Map<string, [number, number]>(),
) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  for (let at = from; at < to;) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const name = path ? `${path}/${type}` : type;
    out.set(name, [at + 8, at + size]);
    if (['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl'].includes(type)) {
      boxesOf(file, at + 8, at + size, name, out);
    }
    assert.ok(size >= 8, `${name} has a size`);
    at += size;
  }
  return out;
}

const STBL = 'moov/trak/mdia/minf/stbl';

function joined(pieces: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function mp4Of(count = 9, every = 4, duration: number | null = null) {
  const { bytes } = webmStream({ count, every });
  const { reader, packets } = readWhole(bytes);
  const file = joined(
    vp9Mp4(
      { width: 320, height: 180, colour: reader.video!.colour, duration },
      packets,
    ),
  );
  return {
    file,
    packets,
    boxes: boxesOf(file),
    view: new DataView(file.buffer),
  };
}

test('the file holds each sample untouched, where its tables say', () => {
  const { file, packets, boxes, view } = mp4Of();
  assert.deepEqual([...boxes.keys()].slice(0, 2), ['ftyp', 'moov']);
  // the tables come first, so a player needs nothing of the file's end
  const moov = boxes.get('moov')!;
  const mdat = boxes.get('mdat')!;
  assert.ok(moov[1] <= mdat[0]);

  const [stsz] = boxes.get(`${STBL}/stsz`)!;
  assert.equal(view.getUint32(stsz + 4), 0, 'no one size for every sample');
  assert.equal(view.getUint32(stsz + 8), packets.length);
  const [stco] = boxes.get(`${STBL}/stco`)!;
  assert.equal(view.getUint32(stco + 4), 1, 'one chunk');
  let at = view.getUint32(stco + 8);
  assert.equal(at, mdat[0]);
  packets.forEach((packet, i) => {
    const size = view.getUint32(stsz + 12 + i * 4);
    assert.equal(size, packet.data.length);
    assert.equal(hex(file.subarray(at, at + size)), hex(packet.data));
    at += size;
  });
  assert.equal(at, file.length, 'and nothing after them');
});

test("the samples' times are the blocks', and the last lasts to the stream's end", () => {
  const { boxes, view } = mp4Of(9, 4, 0.5);
  const [stts] = boxes.get(`${STBL}/stts`)!;
  const runs = view.getUint32(stts + 4);
  const times: number[] = [];
  let tick = 0;
  for (let r = 0; r < runs; r += 1) {
    const count = view.getUint32(stts + 8 + r * 8);
    const delta = view.getUint32(stts + 12 + r * 8);
    for (let i = 0; i < count; i += 1) {
      times.push(tick / 90000);
      tick += delta;
    }
  }
  assert.deepEqual(
    times.map((t) => Math.round(t * 1000) / 1000),
    Array.from({ length: 9 }, (_, i) => Math.round((i / 30) * 1000) / 1000),
  );
  assert.equal(tick / 90000, 0.5);
  const [mdhd] = boxes.get('moov/trak/mdia/mdhd')!;
  assert.equal(view.getUint32(mdhd + 12), 90000);
  assert.equal(view.getUint32(mdhd + 16), 45000);
});

test("a key frame is a sync sample, by VP9's header and not the container's", () => {
  const { boxes, view } = mp4Of(9, 4);
  const [stss] = boxes.get(`${STBL}/stss`)!;
  assert.equal(view.getUint32(stss + 4), 3);
  assert.deepEqual(
    [0, 1, 2].map((i) => view.getUint32(stss + 8 + i * 4)),
    [1, 5, 9],
  );
});

test('the sample entry is the VP Codec binding, with the colours the stream said', () => {
  const { file, boxes } = mp4Of();
  const [stsd, end] = boxes.get(`${STBL}/stsd`)!;
  const entry = file.subarray(stsd + 8, end);
  assert.equal(String.fromCharCode(...entry.subarray(4, 8)), 'vp09');
  const view = new DataView(entry.buffer, entry.byteOffset, entry.length);
  assert.equal(view.getUint16(32), 320);
  assert.equal(view.getUint16(34), 180);
  const vpcC = 86;
  assert.equal(
    String.fromCharCode(...entry.subarray(vpcC + 4, vpcC + 8)),
    'vpcC',
  );
  const body = entry.subarray(vpcC + 8);
  assert.equal(body[0], 1, 'version');
  const [profile, level, packed, primaries, transfer, matrix] =
    body.subarray(4);
  assert.equal(profile, 0);
  assert.equal(level, 11, '320x180 at 30 a second');
  assert.equal(packed, (8 << 4) | (1 << 1), '8 bits, 4:2:0, video range');
  assert.deepEqual([primaries, transfer, matrix], [1, 13, 1]);
});

/** A `VideoClips` over a disk that is a map. */
function clipsOf(plays = true) {
  const files = new Map<string, Uint8Array>();
  const shown: [string, string | null][] = [];
  const element = (name: string) => ({ name }) as never;
  let next = 0;
  const clips = new VideoClips({
    plays: () => plays,
    write: async (pieces) => {
      next += 1;
      files.set(`clip-${next}`, joined(pieces));
      return `clip-${next}`;
    },
    remove: (path) => void files.delete(path),
    show: (el, file) =>
      void shown.push([(el as unknown as { name: string }).name, file]),
  });
  return { clips, files, shown, element };
}

test("a clip takes only WebM's VP9, and only where the player plays it", () => {
  const { clips, element } = clipsOf();
  assert.equal(clips.open('video/mp4;codecs="avc1.42E01E"', element('a')), 0);
  assert.equal(clips.open('audio/webm;codecs="opus"', element('a')), 0);
  assert.equal(clips.open('video/webm', element('a')), 0, 'it names its codec');
  assert.equal(clips.open('video/webm;codecs="vp8"', element('a')), 0);
  assert.notEqual(clips.open('video/webm;codecs="vp9"', element('a')), 0);
  assert.notEqual(clips.open('video/webm; codecs=vp9', element('b')), 0);
  assert.notEqual(
    clips.open('video/webm; codecs="vp09.00.10.08"', element('c')),
    0,
  );
  const none = clipsOf(false);
  assert.equal(
    none.clips.open('video/webm;codecs="vp9"', none.element('a')),
    0,
  );
});

test('a player has one track to play, so an element has one clip', () => {
  const { clips, element } = clipsOf();
  const el = element('a');
  assert.notEqual(clips.open('video/webm;codecs="vp9"', el), 0);
  assert.equal(clips.open('video/webm;codecs="vp9"', el), 0);
});

test('what an append comes to says the head once, and what is buffered each time', () => {
  const { clips, element } = clipsOf();
  const id = clips.open('video/webm;codecs="vp9"', element('a'));
  const { bytes } = webmStream({ count: 6 });
  const half = bytes.length - 12;
  const first = clips.append(id, bytes.subarray(0, half));
  assert.equal(first.width, 320);
  assert.equal(first.height, 180);
  assert.equal(first.duration, 0.2);
  const second = clips.append(id, bytes.subarray(half));
  assert.equal(second.width, undefined, 'the head is told once');
  assert.deepEqual(second.ranges.length, 1);
  assert.equal(second.ranges[0][0], 0);
  assert.ok(Math.abs(second.ranges[0][1] - 0.2) < 0.001);
});

test('an init segment on its own says what the stream is, with no cluster after it', () => {
  const { bytes } = webmStream({ count: 2 });
  // as far as the end of the Tracks: where the first cluster's id starts
  const cluster = Buffer.from(bytes).indexOf(
    Buffer.from([0x1f, 0x43, 0xb6, 0x75]),
  );
  const reader = new WebmReader();
  assert.deepEqual(reader.push(bytes.subarray(0, cluster)), []);
  assert.equal(reader.video?.width, 320);
});

test('a gap in what is appended is two ranges, and removing makes one', () => {
  const { clips, element } = clipsOf();
  const id = clips.open('video/webm;codecs="vp9"', element('a'));
  clips.append(id, webmStream({ count: 12 }).bytes);
  const { ranges } = clips.remove(id, 0.15, 0.25);
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0][1] <= 0.17);
  assert.ok(Math.abs(ranges[1][0] - 0.2667) < 0.001);
});

test('a stream that ends is a file for the player, which goes with the clip', async () => {
  const { clips, files, shown, element } = clipsOf();
  const id = clips.open('video/webm;codecs="vp9"', element('a'));
  clips.append(id, webmStream({ count: 5 }).bytes);
  clips.end(id);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(shown, [['a', 'clip-1']]);
  const boxes = boxesOf(files.get('clip-1')!);
  assert.ok(boxes.has(`${STBL}/stsd`));
  clips.close(id);
  assert.deepEqual(shown.at(-1), ['a', null]);
  assert.equal(files.size, 0, 'the file goes with it');
});

test('a clip gone before its file is written leaves no file behind', async () => {
  const { clips, files, shown, element } = clipsOf();
  const id = clips.open('video/webm;codecs="vp9"', element('a'));
  clips.append(id, webmStream({ count: 5 }).bytes);
  clips.end(id);
  clips.dispose();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(files.size, 0);
  assert.deepEqual(shown, []);
});

test('a page that appends after the end gets a file of all of it, in place of the first', async () => {
  const { clips, files, shown, element } = clipsOf();
  const id = clips.open('video/webm;codecs="vp9"', element('a'));
  clips.append(id, webmStream({ count: 5 }).bytes);
  clips.end(id);
  await new Promise((r) => setTimeout(r, 0));
  clips.end(id);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    shown.map(([, file]) => file),
    ['clip-1', 'clip-2'],
  );
  assert.deepEqual([...files.keys()], ['clip-2']);
});
