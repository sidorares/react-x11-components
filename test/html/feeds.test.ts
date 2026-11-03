// A page's `MediaSource` of H.264 and AAC on its way to the platform's
// player: read as the page appends it (`fmp4.ts`), kept as MSE's track
// buffers and cut into the segments of a playlist the player reloads
// (`feeds.ts`), and served over loopback (`loopback.ts`). The bytes of each
// sample are the point, as for a clip (`clips.test.ts`): nothing is decoded,
// so what the player is handed has to be what the page appended.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { Element } from 'domhandler';
import {
  act,
  cleanup,
  createMockApp,
  fakeMediaPlayers,
  renderX11,
} from 'react-x11/test';

import { Html, useHtmlHandle } from '../../src/html/index.js';
import type { HtmlHandle } from '../../src/html/index.js';
import { canPlayMedia } from '../../src/html/network.js';
import { preloadHtmlScripts, useScripts } from '../../src/html/scripts/hook.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type { ScriptsOptions } from '../../src/html/scripts/runner.js';
import { findById, h } from './harness.js';

import {
  Fmp4Reader,
  initSegment,
  mediaSegment,
  readInit,
} from '../../src/html/scripts/fmp4.js';
import type { Fmp4Item, Fmp4Sample } from '../../src/html/scripts/fmp4.js';
import { Feeds, feedTakes, TARGET } from '../../src/html/scripts/feeds.js';
import type { AppendParams, FeedReply } from '../../src/html/scripts/feeds.js';
import {
  audioSamples,
  fmp4Init,
  fmp4Segment,
  join,
  videoSamples,
} from '../fmp4-fixture.js';
import { mulberry32 } from '../mulberry32.js';

await preloadHtmlScripts();

afterEach(cleanup);

/** A test of a page's scripts, which run only where the engine is
 *  contained (`SCRIPTS_CONTAINED`). */
const scriptedTest = SCRIPTS_CONTAINED ? test : test.skip;

/** YouTube's video: 15360 ticks a second, 30 frames, its first a frame in
 *  by its edit list, a key frame every 151 frames (some five seconds). */
const FRAME = 512;
const GOP = 151;
const VIDEO = {
  kind: 'video' as const,
  timescale: 15360,
  width: 640,
  height: 360,
  shift: FRAME,
};
/** And its audio: AAC's frames of 1024 at 44.1 kHz. */
const AUDIO = { kind: 'audio' as const, timescale: 44100 };
const AAC = 1024;

/** The video's `k`th segment: a GOP. */
const videoSegment = (k: number) =>
  fmp4Segment(k + 1, k * GOP * FRAME, videoSamples(k * GOP, GOP, FRAME, GOP));
/** The audio's `k`th segment: `count` frames, ten seconds where none said. */
const audioSegment = (k: number, count = 431) =>
  fmp4Segment(k + 1, k * count * AAC, audioSamples(k * count, count, AAC));

function read(bytes: Uint8Array, chunk = bytes.length) {
  const reader = new Fmp4Reader();
  const items: Fmp4Item[] = [];
  for (let at = 0; at < bytes.length; at += chunk) {
    items.push(...reader.push(bytes.subarray(at, at + chunk)));
  }
  const samples = items.flatMap((i) => ('sample' in i ? [i.sample] : []));
  return { reader, items, samples };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Ranges, as a page reads them, to a microsecond. */
function sameRanges(actual: [number, number][], expected: [number, number][]) {
  const round = (r: [number, number][]) =>
    r.map(([a, b]) => [Math.round(a * 1e6), Math.round(b * 1e6)]);
  assert.deepEqual(round(actual), round(expected));
}
const said = (s: Fmp4Sample) => [s.dts, s.pts, s.duration, s.sync, hex(s.data)];

test("an init segment says each track's codec, size, timescale and where its edit list starts it", () => {
  const video = readInit(
    fmp4Init({ ...VIDEO, duration: 634_567 }).subarray(24),
  );
  assert.ok(video);
  assert.equal(video.tracks.length, 1);
  const [v] = video.tracks;
  assert.deepEqual(
    [v.id, v.kind, v.format, v.codec, v.width, v.height, v.timescale, v.shift],
    [1, 'video', 'avc1', 'avc1.4d401f', 640, 360, 15360, FRAME],
  );
  // `mehd`, in the movie's ticks
  assert.equal(video.duration, 634_567 / 15360);
  const [a] = readInit(fmp4Init(AUDIO).subarray(24))!.tracks;
  assert.deepEqual(
    [a.kind, a.format, a.codec, a.timescale, a.shift],
    ['audio', 'mp4a', 'mp4a.40.2', 44100, 0],
  );
});

test('samples come as their last byte arrives, wherever the stream is cut', () => {
  const bytes = join([fmp4Init(VIDEO), videoSegment(0), videoSegment(1)]);
  const whole = read(bytes);
  assert.equal(whole.reader.failed, null);
  assert.equal(whole.samples.length, 2 * GOP);
  // a fetch hands a page whatever arrived, as YouTube appends a segment in
  // pieces of ten kilobytes: in a box's head, its body, or a sample
  const random = mulberry32(7);
  for (let round = 0; round < 40; round += 1) {
    const reader = new Fmp4Reader();
    const samples: Fmp4Sample[] = [];
    for (let at = 0; at < bytes.length;) {
      const n = 1 + Math.floor(random() * (round < 20 ? 40 : 4000));
      for (const item of reader.push(bytes.subarray(at, at + n))) {
        if ('sample' in item) samples.push(item.sample);
      }
      at += n;
    }
    assert.equal(reader.failed, null, `round ${round}`);
    assert.deepEqual(
      samples.map(said),
      whole.samples.map(said),
      `round ${round}`,
    );
  }
  // and a sample is out as soon as its own bytes are, before the rest of
  // its `mdat`
  const init = fmp4Init(VIDEO);
  const segment = videoSegment(0);
  const reader = new Fmp4Reader();
  reader.push(init);
  const mdat =
    segment.length -
    videoSamples(0, GOP, FRAME, GOP).reduce((n, s) => n + s.data.length, 0);
  const firstTwo = 24 + 25;
  const out = reader.push(segment.subarray(0, mdat + firstTwo));
  assert.equal(out.length, 2);
});

test("a frame's times are its decode less the edit list's start, and its presentation its composition offset more", () => {
  const { samples } = read(join([fmp4Init(VIDEO), videoSegment(0)]));
  // I P B B: decode 0, 1, 2, 3 frames; shown 1, 4, 2, 3 frames; all a frame
  // earlier for the edit list
  assert.deepEqual(
    samples.slice(0, 4).map((s) => [s.dts / FRAME, s.pts / FRAME, s.sync]),
    [
      [-1, 0, true],
      [0, 3, false],
      [1, 1, false],
      [2, 2, false],
    ],
  );
  // the GOP's presentations are each frame once, from 0
  const shown = samples.map((s) => s.pts / FRAME).sort((x, y) => x - y);
  assert.deepEqual(
    shown,
    Array.from({ length: GOP }, (_, i) => i),
  );
});

test('a fragment with no tfdt goes on from where the last ended', () => {
  const segment = videoSegment(1);
  // the same fragment, its `tfdt` made a `free` box nobody reads
  const at = Buffer.from(segment).indexOf('tfdt');
  const bare = segment.slice();
  bare.set([0x66, 0x72, 0x65, 0x65], at);
  const { samples } = read(join([fmp4Init(VIDEO), videoSegment(0), bare]));
  assert.equal(samples[GOP].dts, GOP * FRAME - FRAME);
});

test('what no stream is fails it, and says why', () => {
  assert.match(
    read(videoSegment(0)).reader.failed ?? '',
    /media segment before an initialization segment/,
  );
  const segment = videoSegment(0);
  // a sample larger than its `mdat` has room for
  const short = join([
    fmp4Init(VIDEO),
    segment.subarray(0, segment.length - 30),
  ]);
  const view = new DataView(short.buffer, short.byteOffset);
  const mdatAt = Buffer.from(short).lastIndexOf('mdat') - 4;
  view.setUint32(mdatAt, short.length - mdatAt);
  assert.match(
    read(short).reader.failed ?? '',
    /past the end of its media data/,
  );
});

test("a segment of the player's reads back as the frames it was cut from, offsets less than nothing included", () => {
  const track = readInit(fmp4Init(VIDEO).subarray(24))!.tracks[0];
  const init = initSegment(track);
  const again = readInit(init.subarray(Buffer.from(init).indexOf('moov') - 4));
  assert.equal(again?.tracks[0].codec, 'avc1.4d401f');
  assert.equal(again?.tracks[0].shift, 0, 'no edit list of its own');
  const samples = [
    { duration: 512, cto: 0, sync: true, data: new Uint8Array([1, 2, 3]) },
    { duration: 512, cto: 1024, sync: false, data: new Uint8Array([4, 5]) },
    { duration: 512, cto: -512, sync: false, data: new Uint8Array([6]) },
  ];
  const { samples: back, reader } = read(
    join([init, ...mediaSegment(4, 2 ** 33, samples)]),
  );
  assert.equal(reader.failed, null);
  assert.deepEqual(
    back.map((s) => [s.dts - 2 ** 33, s.pts - 2 ** 33, s.sync, [...s.data]]),
    [
      [0, 0, true, [1, 2, 3]],
      [512, 1536, false, [4, 5]],
      [1024, 512, false, [6]],
    ],
  );
});

test('a feed takes MP4 of H.264 and AAC, whatever else the type says, and no other', () => {
  for (const type of [
    'video/mp4; codecs="avc1.42001E"',
    'video/mp4; codecs="avc1.4D401F"; width=640',
    'video/mp4; codecs="avc1.4d401e"; decode-to-texture=true',
    'audio/mp4; codecs="mp4a.40.2"',
    'audio/mp4; codecs="mp4a.40.2"; channels=2',
    'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs=avc1.64002A',
    'video/mp4',
  ]) {
    assert.equal(feedTakes(type), true, type);
  }
  for (const type of [
    'video/webm; codecs="vp9"',
    'video/mp4; codecs=av01.0.05M.08',
    'video/mp4; codecs="vp09.00.51.08.01.01.01.01.00"',
    'audio/webm; codecs="opus"',
    'audio/mp4; codecs="avc1.42001E"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs=""',
    'video/mp2t; codecs="avc1.42E01E"',
  ]) {
    assert.equal(feedTakes(type), false, type);
  }
});

// --- the host's half ----------------------------------------------------------

const PARAMS: AppendParams = {
  offset: 0,
  mode: 'segments',
  windowStart: 0,
  windowEnd: Infinity,
  time: 0,
};

/** A feed for one `<video>`, its player's URLs and requests kept. */
function feedFor(time = 0) {
  const shown: [string | null, number | undefined][] = [];
  let request:
    | ((
        path: string,
        q: Map<string, string>,
        gone: Promise<void>,
      ) => FeedReply | Promise<FeedReply>)
    | null = null;
  let served = 0;
  const unserved: string[] = [];
  const feeds = new Feeds({
    show: (_el, url, at) => void shown.push([url, at]),
    serve: (_token, route) => {
      served += 1;
      request = route;
      return Promise.resolve('http://loopback');
    },
    unserve: (token) => void unserved.push(token),
  });
  const element = new Element('video', {});
  let next = 1;
  const open = () => {
    const id = next++;
    feeds.open(id, element, 'blob:page', time);
    return id;
  };
  /** A request under the token, by its path. */
  const get = async (
    path: string,
    query: Record<string, string> = {},
    gone = new Promise<void>(() => {}),
  ) => {
    assert.ok(request, 'served');
    return await request!(path, new Map(Object.entries(query)), gone);
  };
  const text = (r: FeedReply) => Buffer.concat(r.body ?? []).toString('latin1');
  return {
    feeds,
    element,
    open,
    shown,
    get,
    text,
    served: () => served,
    unserved,
    feed: () => feeds.of(element)!,
  };
}

/** Lets a promise the feed made settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A playlist's segments, as `[EXTINF, URI]`, and its maps. */
function listed(text: string) {
  const lines = text.split('\n');
  const segments: [number, string][] = [];
  const maps: string[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith('#EXTINF:'))
      segments.push([parseFloat(line.slice(8)), lines[i + 1]]);
    const m = /^#EXT-X-MAP:URI="([^"]+)"/.exec(line);
    if (m) maps.push(m[1]);
  });
  return { segments, maps, ended: text.includes('#EXT-X-ENDLIST') };
}

test("what is buffered grows a frame at a time, and a track's buffer is what its frames show", () => {
  const f = feedFor();
  const v = f.open();
  const init = f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  assert.deepEqual(init.init, { width: 640, height: 360, duration: null });
  assert.deepEqual(init.ranges, []);
  const segment = videoSegment(0);
  // a third of it: the frames whose bytes are all there
  const part = f.feeds.append(
    v,
    segment.subarray(0, segment.length / 3),
    PARAMS,
  );
  assert.equal(part.ranges.length, 1);
  assert.ok(
    part.ranges[0][1] > 0 && part.ranges[0][1] < GOP / 30,
    `${part.ranges}`,
  );
  const rest = f.feeds.append(v, segment.subarray(segment.length / 3), PARAMS);
  sameRanges(rest.ranges, [[0, (GOP * FRAME) / 15360]]);
});

test('a gap is two ranges; a removal takes what shows in it and on to the next key frame', () => {
  const f = feedFor();
  const v = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  for (const k of [0, 1, 3]) f.feeds.append(v, videoSegment(k), PARAMS);
  const s = (frames: number) => (frames * FRAME) / 15360;
  sameRanges(f.feeds.append(v, new Uint8Array(), PARAMS).ranges, [
    [0, s(2 * GOP)],
    [s(3 * GOP), s(4 * GOP)],
  ]);
  // from the middle of the first GOP to the middle of the second: on to
  // the third's key frame, which is the second range's start, and the
  // frame shown 49th with it, a B-frame decoded after the P-frame shown
  // 51st, which went (MSE 3.5.9 step 3.4)
  sameRanges(f.feeds.remove(v, s(50), s(GOP + 50)).ranges, [
    [0, s(49)],
    [s(3 * GOP), s(4 * GOP)],
  ]);
});

test('an append over what is buffered takes its place, and a timestamp offset moves what comes', () => {
  const f = feedFor();
  const v = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  f.feeds.append(v, videoSegment(0), PARAMS);
  f.feeds.append(v, videoSegment(1), PARAMS);
  // another quality of the first GOP: one more init, the same times
  f.feeds.append(
    v,
    fmp4Init({ ...VIDEO, width: 1280, height: 720, level: 0x20 }),
    PARAMS,
  );
  const again = f.feeds.append(v, videoSegment(0), PARAMS);
  const end = (2 * GOP * FRAME) / 15360;
  sameRanges(again.ranges, [[0, end]]);
  // and moved on by twenty seconds, as a page that splices does
  const moved = f.feeds.append(v, videoSegment(0), { ...PARAMS, offset: 20 });
  sameRanges(moved.ranges, [
    [0, end],
    [20, 20 + (GOP * FRAME) / 15360],
  ]);
});

test('an append window keeps out what shows past it, and abort() starts the parser at the next segment', () => {
  const f = feedFor();
  const v = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  const until = (100 * FRAME) / 15360;
  const kept = f.feeds.append(v, videoSegment(0), {
    ...PARAMS,
    windowEnd: until,
  });
  sameRanges(kept.ranges, [[0, until]]);
  // half a segment, then abort: the half is all that is kept of it
  const segment = videoSegment(1);
  f.feeds.append(v, segment.subarray(0, 600), PARAMS);
  f.feeds.reset(v);
  const after = f.feeds.append(v, videoSegment(2), PARAMS);
  assert.equal(after.failed, undefined);
  assert.equal(after.ranges.length, 2);
});

test("a source's buffers are what each of them holds, and a full one refuses an append with nothing before the clock to let go", () => {
  const f = feedFor();
  const v = f.open();
  const a = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  const audio = f.feeds.append(a, fmp4Init(AUDIO), PARAMS);
  assert.deepEqual(audio.init, { width: 0, height: 0, duration: null });
  f.feeds.append(a, audioSegment(0), PARAMS);
  sameRanges(f.feeds.append(a, new Uint8Array(), PARAMS).ranges, [
    [0, (431 * AAC) / 44100],
  ]);
  // twelve megabytes of audio, a twentieth of a second of it, with the
  // clock at its start: nothing can go
  const big = Array.from({ length: 6 }, (_, k) =>
    fmp4Segment(100 + k, (431 + k) * AAC, [
      { duration: AAC, sync: true, data: new Uint8Array(2 << 20) },
    ]),
  );
  const answers = big.map((b) => f.feeds.append(a, b, PARAMS));
  assert.ok(
    answers.some((r) => r.refused),
    'refused once it would not fit',
  );
  // with the clock past it, what is before the clock goes, and it fits
  const later = f.feeds.append(a, big[5], { ...PARAMS, time: 20 });
  assert.equal(later.refused, undefined);
});

test('the player is handed a playlist of two-second segments once four seconds of both tracks are listed', async () => {
  const f = feedFor();
  const v = f.open();
  const a = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  f.feeds.append(a, fmp4Init(AUDIO), PARAMS);
  f.feeds.append(v, videoSegment(0), PARAMS);
  f.feeds.append(v, videoSegment(1), PARAMS);
  await tick();
  // a length, as an empty `deepEqual` would leave `shown` a `never[]`
  assert.equal(f.shown.length, 0, 'nothing with no audio to go with it');
  f.feeds.append(a, audioSegment(0), PARAMS);
  await tick();
  assert.equal(f.shown.length, 1);
  const [url, at] = f.shown[0];
  assert.match(url!, /^http:\/\/loopback\/[0-9a-f]{32}\/1\/master\.m3u8$/);
  assert.equal(at, 0);
  const path = url!.slice('http://loopback/'.length + 33);
  const master = f.text(await f.get(path));
  assert.match(master, /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a".*URI="a\.m3u8"/);
  assert.match(
    master,
    /CODECS="avc1\.4d401f,mp4a\.40\.2",RESOLUTION=640x360,AUDIO="a"\nv\.m3u8/,
  );
  // its first playlist of each kind lists two segments, so that it starts
  // at the first; the next lists all that is there
  const first = listed(f.text(await f.get('1/v.m3u8')));
  assert.equal(first.segments.length, 2);
  assert.deepEqual(first.maps, ['vi0.mp4']);
  const all = listed(f.text(await f.get('1/v.m3u8')));
  assert.ok(all.segments.length > 2);
  for (const [extinf] of all.segments)
    assert.ok(extinf <= TARGET + 0.04, `${extinf}`);
  assert.equal(all.ended, false);
  assert.equal(listed(f.text(await f.get('1/a.m3u8'))).segments.length, 2);
  const audio = listed(f.text(await f.get('1/a.m3u8')));
  assert.deepEqual(
    audio.segments.map(([d]) => d),
    all.segments.map(([d]) => d),
    "the audio's spans are the video's",
  );
});

test("a segment holds the frames appended, from the session's start, first presentation at first decode", async () => {
  const f = feedFor();
  const v = f.open();
  const a = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  f.feeds.append(a, fmp4Init(AUDIO), PARAMS);
  const appended = read(
    join([fmp4Init(VIDEO), videoSegment(0), videoSegment(1)]),
  ).samples;
  f.feeds.append(v, videoSegment(0), PARAMS);
  f.feeds.append(v, videoSegment(1), PARAMS);
  f.feeds.append(a, audioSegment(0), PARAMS);
  await tick();
  await f.get('1/v.m3u8');
  const playlist = listed(f.text(await f.get('1/v.m3u8')));
  const reader = new Fmp4Reader();
  const back: Fmp4Sample[] = [];
  for (const name of [
    ...playlist.maps,
    ...playlist.segments.map(([, u]) => u),
  ]) {
    const reply = await f.get(`1/${name}`);
    assert.equal(reply.status, 200, name);
    for (const item of reader.push(join(reply.body!))) {
      if ('sample' in item) back.push(item.sample);
    }
  }
  assert.equal(reader.failed, null);
  assert.ok(back.length >= GOP, `${back.length}`);
  // the bytes as appended, in order
  assert.deepEqual(
    back.map((s) => hex(s.data)),
    appended.slice(0, back.length).map((s) => hex(s.data)),
  );
  // decode from 0, the first presentation at it, and each frame shown as
  // far from the first as the page's was
  assert.equal(back[0].dts, 0);
  assert.equal(back[0].pts, 0);
  back.forEach((s, i) => {
    assert.equal(s.dts, appended[i].dts - appended[0].dts, `dts ${i}`);
    assert.equal(s.pts, appended[i].pts - appended[0].pts, `pts ${i}`);
  });
});

test('a blocking reload is held until its segment is listed, and let go with the player', async () => {
  const f = feedFor();
  const v = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  f.feeds.append(v, videoSegment(0), PARAMS);
  await tick();
  await f.get('1/v.m3u8');
  const have = listed(f.text(await f.get('1/v.m3u8'))).segments.length;
  let answered: FeedReply | null = null;
  void Promise.resolve(f.get('1/v.m3u8', { _HLS_msn: String(have) })).then(
    (r) => {
      answered = r;
    },
  );
  await tick();
  await tick();
  assert.equal(answered, null, 'held: nothing new is listed');
  f.feeds.append(v, videoSegment(1), PARAMS);
  await tick();
  assert.ok(answered, 'answered once a segment is');
  assert.ok(listed(f.text(answered)).segments.length > have);
  // further than two ahead is no reload a player asks for
  assert.equal(
    (await f.get('1/v.m3u8', { _HLS_msn: String(have + 50) })).status,
    400,
  );
  let away = (): void => {};
  const gone = new Promise<void>((r) => (away = r));
  const now = listed(f.text(await f.get('1/v.m3u8'))).segments.length;
  const held = Promise.resolve(
    f.get('1/v.m3u8', { _HLS_msn: String(now) }, gone),
  );
  away();
  assert.equal((await held).status, 499);
});

test("the page's end lists the rest and ends the playlist", async () => {
  const f = feedFor();
  const v = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  f.feeds.append(v, videoSegment(0), PARAMS);
  f.feeds.end(v);
  await tick();
  await f.get('1/v.m3u8');
  const all = listed(f.text(await f.get('1/v.m3u8')));
  assert.equal(all.ended, true);
  const total = all.segments.reduce((n, [d]) => n + d, 0);
  assert.ok(Math.abs(total - (GOP * FRAME) / 15360) < 0.001, `${total}`);
});

test("a seek inside what the player has is the player's; one past it is a session of its own, which starts where the page went", async () => {
  const f = feedFor();
  const v = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  for (let k = 0; k < 6; k += 1) f.feeds.append(v, videoSegment(k), PARAMS);
  await tick();
  const feed = f.feed();
  assert.equal(feed.seek(3), 3, 'the player is sought, in its own seconds');
  // past what the page has: a new session, the player let go at once, and
  // nothing for the player until the page appends where it went
  assert.equal(feed.seek(40), null);
  assert.deepEqual(f.shown.at(-1), [null, undefined]);
  await tick();
  assert.equal(f.shown.at(-1)![0], null);
  for (let k = 7; k < 10; k += 1) f.feeds.append(v, videoSegment(k), PARAMS);
  await tick();
  const [url, at] = f.shown.at(-1)!;
  assert.match(url!, /\/2\/master\.m3u8$/, 'a session of its own');
  // from the key frame before 40 s, the player sought to where 40 s is
  const key = (7 * GOP) / 30;
  assert.ok(Math.abs(at! - (40 - key)) < 0.000001, `${at}`);
  // what the old session's player says is nobody's now, and the new one's
  // is told in the page's seconds
  assert.equal(
    feed.playerSaid('http://loopback/x/1/master.m3u8', 'time', '4'),
    null,
  );
  const news = feed.playerSaid(url!, 'time', '1.5');
  assert.equal(news?.kind, 'time');
  assert.ok(Math.abs(Number(news?.value) - (key + 1.5)) < 0.000001);
  // and near the end of what is listed, where the player would not go,
  // a seek is a session of its own too, at once where the page has it
  assert.equal(feed.seek(44), null);
  await tick();
  assert.match(f.shown.at(-1)![0]!, /\/3\/master\.m3u8$/);
});

test("a player's failure starts its session again where it was, and reaches the page only once sessions keep failing", async () => {
  const f = feedFor();
  const v = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  for (let k = 0; k < 4; k += 1) f.feeds.append(v, videoSegment(k), PARAMS);
  await tick();
  const feed = f.feed();
  let url = f.shown.at(-1)![0]!;
  assert.deepEqual(feed.playerSaid(url, 'time', '7'), {
    kind: 'time',
    value: '7',
  });
  for (let i = 0; i < 2; i += 1) {
    assert.equal(feed.playerSaid(url, 'error', 'Cannot Open'), null);
    await tick();
    const next = f.shown.at(-1)![0]!;
    assert.notEqual(next, url, 'a new session');
    url = next;
  }
  assert.deepEqual(feed.playerSaid(url, 'error', 'Cannot Open'), {
    kind: 'error',
    value: 'Cannot Open',
  });
});

test('a feed with all its buffers closed lets the server go', async () => {
  const f = feedFor();
  const v = f.open();
  f.feeds.append(v, fmp4Init(VIDEO), PARAMS);
  f.feeds.append(v, videoSegment(0), PARAMS);
  await tick();
  assert.equal(f.served(), 1);
  const token = f.feed().token;
  f.feeds.close(v);
  assert.deepEqual(f.unserved, [token]);
  assert.deepEqual(f.shown.at(-1), [null, undefined]);
  assert.equal(f.feeds.of(f.element), undefined);
});

// --- a page's, over loopback, to a player -------------------------------------

const PAGE_URL = 'https://example.test/watch';

/**
 * `source` in an `<Html>` over a mock app with a player that plays nothing,
 * its scripts run, the player reading HLS and MP4 (`canPlayType`), and
 * `files` its `fetch` answers, by the last part of the URL.
 */
async function mount(source: string, files: Record<string, Uint8Array>) {
  const app = createMockApp();
  const players = fakeMediaPlayers(app);
  const out = {
    handle: null as unknown as HtmlHandle,
    exec: (_code: string): void => {},
  };
  const seams: ScriptsOptions = {
    userAgent: 'test',
    language: 'en-US',
    viewport: () => ({
      width: 400,
      height: 300,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      dpr: 1,
      left: 0,
      top: 0,
    }),
    scrollTo: () => {},
    navigate: () => {},
    reload: () => {},
    go: () => {},
    log: () => {},
    title: () => {},
    fetch: async (request) => {
      const bytes = files[request.url.slice(request.url.lastIndexOf('/') + 1)];
      if (!bytes) throw new Error('no answer');
      return {
        url: request.url,
        status: 200,
        statusText: 'OK',
        redirected: false,
        headers: [['content-type', 'video/mp4']],
        body: '',
        bytes,
      };
    },
    load: async () => null,
    onTimeout: () => {},
    canPlayType: (type) => canPlayMedia(type),
  };
  function Page() {
    const handle = useHtmlHandle();
    out.handle = handle;
    const run = useScripts(true, handle, PAGE_URL, seams);
    out.exec = (code) => void run.runner?.()?.engine.exec(code, 'test', 0);
    return h(Html, {
      source,
      partial: false,
      ref: handle.ref,
      baseUrl: PAGE_URL,
      ...run,
      // as `useScriptedHtml` hands it to `<Html>`, an internal prop
      ...({ _onMediaEvent: run.mediaEvent } as object),
    });
  }
  await renderX11(h('box', { style: { width: 400 } }, h(Page)), {
    app,
    backend: 'mock',
  });
  const text = (id: string) => {
    const el = findById(out.handle.document, id) as unknown as {
      children: { data?: string }[];
    };
    return el?.children?.map((c) => c.data ?? '').join('') ?? '';
  };
  return {
    players,
    text,
    exec: (code: string) => act(() => out.exec(code)),
  };
}

async function settle(ms = 20) {
  for (let i = 0; i < 4; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, ms / 4)));
  }
}

async function until(done: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await settle();
}

/** What a page appends: the video's first four GOPs and twenty seconds
 *  of its audio, each a file its `fetch` gets. */
const FILES: Record<string, Uint8Array> = {
  'v-init': fmp4Init(VIDEO),
  'a-init': fmp4Init(AUDIO),
  ...Object.fromEntries(
    [0, 1, 2, 3, 7, 8, 9].map((k) => [`v-${k}`, videoSegment(k)]),
  ),
  ...Object.fromEntries([0, 1, 2, 4].map((k) => [`a-${k}`, audioSegment(k)])),
};

/** A page with a `MediaSource` of both, its element's events logged in
 *  `#out`, and `feed(sb, names)` to append files one after another. */
const PLAYER_PAGE =
  '<video id="v" style="display:block;width:320px;height:180px"></video><p id="out"></p><script>' +
  'var v = document.getElementById("v"), r = [], ms = new MediaSource(), vb, ab;' +
  'function log(x) { r.push(x); document.getElementById("out").textContent = JSON.stringify(r); }' +
  'log(["types", MediaSource.isTypeSupported(\'video/mp4; codecs="avc1.4D401F"\'),' +
  '  MediaSource.isTypeSupported(\'audio/mp4; codecs="mp4a.40.2"\'),' +
  '  MediaSource.isTypeSupported(\'video/webm; codecs="vp9"\')]);' +
  '["loadedmetadata", "canplay", "playing", "waiting", "seeking", "seeked"].forEach(function (e) {' +
  '  v.addEventListener(e, function () { log([e, v.readyState]); }); });' +
  'function feed(sb, names, then) { if (!names.length) { if (then) then(); return; }' +
  '  fetch(names[0]).then(function (res) { return res.arrayBuffer(); }).then(function (b) {' +
  '    sb.addEventListener("updateend", function f() { sb.removeEventListener("updateend", f); feed(sb, names.slice(1), then); });' +
  '    sb.appendBuffer(b); }); }' +
  'v.src = URL.createObjectURL(ms);' +
  'ms.addEventListener("sourceopen", function () {' +
  '  ms.duration = 600;' +
  '  vb = ms.addSourceBuffer(\'video/mp4; codecs="avc1.4D401F"\');' +
  '  ab = ms.addSourceBuffer(\'audio/mp4; codecs="mp4a.40.2"\');' +
  '  feed(vb, ["v-init"], function () { log(["one init", v.readyState]);' +
  '    feed(ab, ["a-init", "a-0", "a-1"], function () { feed(vb, ["v-0", "v-1", "v-2", "v-3"], function () { log(["appended"]); }); }); });' +
  '  v.play();' +
  '});' +
  '</script>';

const events = (doc: { text(id: string): string }) =>
  JSON.parse(doc.text('out') || '[]') as unknown[][];

scriptedTest(
  "a page's MediaSource of H.264 and AAC is handed to the player as it is appended, a playlist over loopback of what the page appended",
  async () => {
    const doc = await mount(PLAYER_PAGE, FILES);
    await until(() => events(doc).some((e) => e[0] === 'appended'));
    const log = events(doc);
    // MSE where the player reads HLS, and still no VP9 to stream
    assert.deepEqual(log[0], ['types', true, true, false]);
    // its metadata once both buffers have had their init segment, and not
    // at the first
    const names = log.map((e) => e[0]);
    assert.ok(
      names.indexOf('one init') < names.indexOf('loadedmetadata'),
      `${names}`,
    );
    assert.deepEqual(
      log.find((e) => e[0] === 'one init'),
      ['one init', 0],
    );
    await until(() => doc.players.players.length > 0);
    const player = doc.players.last!;
    assert.match(
      player.src,
      /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/1\/master\.m3u8$/,
    );
    // what the player reads, over HTTP
    const master = await fetch(player.src);
    assert.equal(master.status, 200);
    assert.equal(
      master.headers.get('content-type'),
      'application/vnd.apple.mpegurl',
    );
    assert.match(await master.text(), /CODECS="avc1\.4d401f,mp4a\.40\.2"/);
    const base = player.src.slice(0, player.src.lastIndexOf('/') + 1);
    await fetch(base + 'v.m3u8');
    const playlist = listed(await (await fetch(base + 'v.m3u8')).text());
    const reader = new Fmp4Reader();
    const back: Fmp4Sample[] = [];
    for (const name of [
      ...playlist.maps,
      ...playlist.segments.map(([, u]) => u),
    ]) {
      const reply = await fetch(base + name);
      assert.equal(reply.status, 200, name);
      for (const item of reader.push(
        new Uint8Array(await reply.arrayBuffer()),
      )) {
        if ('sample' in item) back.push(item.sample);
      }
    }
    const appended = read(
      join([fmp4Init(VIDEO), ...[0, 1, 2, 3].map(videoSegment)]),
    ).samples;
    assert.ok(back.length > 2 * GOP, `${back.length}`);
    assert.deepEqual(
      back.map((s) => hex(s.data)),
      appended.slice(0, back.length).map((s) => hex(s.data)),
    );
    // a token that is not the feed's reads nothing
    assert.equal(
      (await fetch(player.src.replace(/[0-9a-f]{32}/, '0'.repeat(32)))).status,
      404,
    );
  },
);

scriptedTest(
  "its clock is its player's, and waits at the end of what is buffered until the page appends more",
  async () => {
    const doc = await mount(PLAYER_PAGE, FILES);
    await until(
      () =>
        events(doc).some((e) => e[0] === 'appended') &&
        doc.players.players.length > 0,
    );
    const player = doc.players.last!;
    const now = async () => {
      await doc.exec('log(["t", v.currentTime, v.readyState])');
      const t = events(doc)
        .filter((e) => e[0] === 't')
        .at(-1)!;
      return [t[1] as number, t[2] as number];
    };
    // no further than half a second past where the player last said, which
    // is nowhere yet
    const [before] = await now();
    assert.ok(before <= 0.5, `before ${before}`);
    await act(() => {
      player.ready({ duration: Infinity, width: 640, height: 360 });
      player.state(true);
      player.time(12);
    });
    await settle(60);
    const [at] = await now();
    assert.ok(at >= 12 && at <= 12.5, `${at}`);
    // the audio is buffered to twenty seconds: the player says it got there,
    // and the clock waits there
    await act(() => player.time(19.95));
    await until(() => events(doc).some((e) => e[0] === 'waiting'), 3000);
    const waited = events(doc).find((e) => e[0] === 'waiting');
    assert.ok(waited, JSON.stringify(events(doc).slice(-8)));
    assert.ok((waited[1] as number) <= 2, `ready ${waited[1]}`);
    const [held] = await now();
    assert.ok(held <= 20.02, `held ${held}`);
    // more audio, and it plays on
    const playing = events(doc).filter((e) => e[0] === 'playing').length;
    await doc.exec('feed(ab, ["a-2"])');
    await until(
      () => events(doc).filter((e) => e[0] === 'playing').length > playing,
      3000,
    );
    assert.ok(
      events(doc).filter((e) => e[0] === 'playing').length > playing,
      JSON.stringify(events(doc).slice(-8)),
    );
  },
);

scriptedTest(
  'a seek past what the player has is a new player, sought to where the page went once the page has appended it',
  async () => {
    const doc = await mount(PLAYER_PAGE, FILES);
    await until(
      () =>
        events(doc).some((e) => e[0] === 'appended') &&
        doc.players.players.length > 0,
    );
    const first = doc.players.last!;
    await doc.exec('v.currentTime = 40');
    await settle(60);
    assert.equal(first.released, true, 'the player of the old session goes');
    await doc.exec(
      'feed(ab, ["a-4"], function () { feed(vb, ["v-7", "v-8", "v-9"], function () { log(["there"]); }); })',
    );
    await until(
      () =>
        events(doc).some((e) => e[0] === 'there') &&
        doc.players.players.length > 1,
    );
    const second = doc.players.last!;
    assert.match(second.src, /\/2\/master\.m3u8$/);
    // from the key frame before 40 s
    const key = (7 * GOP) / 30;
    const sought = second.calls.find((c) => c[0] === 'seek');
    assert.ok(
      sought && Math.abs((sought[1] as number) - (40 - key)) < 0.001,
      JSON.stringify(second.calls),
    );
    await act(() => second.time(40 - key + 1));
    await settle(60);
    await doc.exec('log(["t", v.currentTime])');
    const t = events(doc)
      .filter((e) => e[0] === 't')
      .at(-1)![1] as number;
    assert.ok(t >= 41 && t <= 41.5, `${t}`);
  },
);
