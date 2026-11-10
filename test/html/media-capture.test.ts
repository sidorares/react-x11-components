// A page's cameras, microphones and screens in a media element: a
// `<video srcObject>`'s states and events as Media Capture 6.2 and HTML
// 4.8.11 have them, `getDisplayMedia` (Screen Capture 5.2), the frames a
// source hands out only while something reads them (`PageSources.read`),
// and react-x11's own devices behind the seam (`coreMediaDevices`), over
// its fake ones (`fakeMediaDevices` from `react-x11/test`).
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import React from 'react';
import {
  act,
  cleanup,
  createMockApp,
  fakeMediaDevices as coreFakes,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
import { useApp } from 'react-x11';
import type { DrawnNode, NtkApp } from 'react-x11';

import {
  Html,
  coreMediaDevices,
  fakeMediaDevices,
  preloadHtmlScripts,
  toI420,
} from '../../src/html/index.js';
import type {
  HtmlScripts,
  MediaSourceLike,
  MediaVideoFrame,
} from '../../src/html/index.js';
import { PageSources } from '../../src/html/scripts/media-sources.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, h, pixelsIn } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What `run` rendered last, for a test that reads its pixels. */
let lastRender: Awaited<ReturnType<typeof renderX11>> | null = null;

/** A page's script, run until it logs a line starting `done`: every line
 *  it logged. A `<button id=b>` is there for a press to land on. */
async function run(
  script: string,
  scripts: HtmlScripts | ((app: NtkApp) => HtmlScripts) = {
    mediaDevices: fakeMediaDevices(),
  },
  options: { press?: boolean } = {},
): Promise<string[]> {
  const logs: string[] = [];
  function Host() {
    const app = useApp();
    const made = React.useMemo(
      () => (typeof scripts === 'function' ? scripts(app) : scripts),
      [app],
    );
    return h(Html, {
      source:
        '<input type="button" id="b" value="press">' +
        '<video id="v" style="width:160px;height:120px"></video><audio id="a"></audio>' +
        '<script>' +
        'function log() { console.log([].slice.call(arguments).join("|")); }' +
        'function wait(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }' +
        'function pressed() { return new Promise(function (r) { document.getElementById("b").onclick = r; }); }' +
        `(async function () { try { ${script} } catch (e) { log("failed", e.name, e.message); } log("done"); })();` +
        '</script>',
      partial: false,
      baseUrl: 'https://page.test/',
      scripts: {
        ...made,
        log: (_level: string, text: string) => void logs.push(text),
      },
    });
  }
  lastRender = await renderX11(
    h(
      'box',
      { style: { width: 400, height: 300, flexDirection: 'column' } },
      h(Host),
    ),
    {
      width: 440,
      height: 340,
      ...(FONTS ? { fonts: FONTS } : { backend: 'mock' as const }),
    },
  );
  const end = Date.now() + 10000;
  let pressed = false;
  while (!logs.includes('done') && Date.now() < end) {
    if (options.press && !pressed && logs.includes('press')) {
      pressed = true;
      await userEvent.click(screen.getByRole('button') as DrawnNode);
    }
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  assert.ok(
    logs.includes('done'),
    `the page never finished:\n${logs.join('\n')}`,
  );
  assert.ok(
    !logs.some((l) => l.startsWith('failed')),
    `the page failed:\n${logs.join('\n')}`,
  );
  return logs;
}

const has = (logs: string[], line: string) =>
  assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);

test('a stream in a <video> loads as Media Capture has it: every event once, in order, ready with no buffering and no length', async () => {
  const logs = await run(`
    var stream = await navigator.mediaDevices.getUserMedia({ video: true });
    var v = document.getElementById('v'), seen = [];
    ['loadstart', 'durationchange', 'resize', 'loadedmetadata', 'loadeddata',
     'canplay', 'canplaythrough', 'suspend', 'progress', 'error', 'abort'].forEach(function (type) {
      v.addEventListener(type, function () { seen.push(type); });
    });
    v.preload = 'metadata';
    v.srcObject = stream;
    log('assigned', v.srcObject === stream, v.networkState, v.readyState, v.duration, v.preload);
    v.preload = 'auto';
    while (seen.indexOf('canplaythrough') < 0) await wait(10);
    await wait(100);
    log('events', seen.join(','));
    log('ready', v.readyState, v.networkState, v.duration, v.videoWidth, v.videoHeight, v.buffered.length, v.seekable.length, v.preload);
    v.srcObject = null;
    log('after', v.preload, v.srcObject);
    stream.getTracks().forEach(function (t) { t.stop(); });
  `);
  has(logs, 'assigned|true|3|0|NaN|none');
  has(
    logs,
    'events|loadstart,durationchange,resize,loadedmetadata,loadeddata,canplay,canplaythrough',
  );
  has(logs, 'ready|4|2|Infinity|640|480|0|0|none');
  has(logs, 'after|metadata|');
});

test('a stream’s clock runs from 0 at one second a second while it plays, and is not sought, nor its rate set', async () => {
  const logs = await run(`
    var stream = await navigator.mediaDevices.getUserMedia({ video: true });
    var v = document.getElementById('v');
    v.defaultPlaybackRate = 0.3;
    v.playbackRate = 0.4;
    await wait(20);
    var rates = 0;
    v.onratechange = function () { rates++; };
    v.srcObject = stream;
    log('rates', v.playbackRate, v.defaultPlaybackRate);
    v.playbackRate = 0.5;
    v.currentTime = 42;
    log('set', v.playbackRate, v.currentTime);
    await v.play();
    await new Promise(function (r) { v.ontimeupdate = r; });
    var t = v.currentTime;
    v.currentTime = 0;
    log('playing', t > 0 && t < 0.6, v.currentTime >= t, v.played.length, v.played.start(0), v.played.end(0) >= t);
    v.pause();
    await new Promise(function (r) { v.onpause = r; });
    var paused = v.currentTime;
    await wait(300);
    log('paused', v.currentTime === paused);
    v.srcObject = null;
    log('unset', v.playbackRate, v.defaultPlaybackRate);
    await wait(50);
    log('ratechange', rates);
    stream.getTracks().forEach(function (t) { t.stop(); });
  `);
  has(logs, 'rates|1|1');
  has(logs, 'set|1|0');
  has(logs, 'playing|true|true|1|0|true');
  has(logs, 'paused|true');
  has(logs, 'unset|0.3|0.3');
  has(logs, 'ratechange|1');
});

test('a <video> ends a task after its stream has no live track, and an <audio> after it has no live audio track', async () => {
  const logs = await run(`
    var stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    var v = document.getElementById('v'), a = document.getElementById('a');
    v.srcObject = stream;
    a.srcObject = stream;
    await v.play();
    await a.play();
    await new Promise(function (r) { v.ontimeupdate = r; });
    var before = v.currentTime;
    stream.getAudioTracks()[0].stop();
    await Promise.resolve();
    log('sync', a.ended, v.ended);
    await new Promise(function (r) { a.onended = r; });
    log('audio ended', a.ended, v.ended, stream.active);
    var durations = [];
    v.ondurationchange = function () { durations.push(v.duration === v.currentTime); };
    stream.removeTrack(stream.getVideoTracks()[0]);
    await new Promise(function (r) { v.onended = r; });
    log('video ended', v.ended, v.paused, durations.join(','), v.currentTime >= before);
  `);
  has(logs, 'sync|false|false');
  has(logs, 'audio ended|true|false|true');
  has(logs, 'video ended|true|true|true|true');
});

test('a canvas’s stream is no picture until it is drawn on, and its size follows the canvas', async () => {
  const logs = await run(`
    var c = document.createElement('canvas');
    var ctx = c.getContext('2d');
    var v = document.getElementById('v');
    var stream = c.captureStream();
    v.srcObject = stream;
    v.play();
    await wait(300);
    log('undrawn', v.readyState);
    ctx.fillStyle = 'green';
    ctx.fillRect(0, 0, c.width, c.height);
    await new Promise(function (r) { v.oncanplay = r; });
    log('drawn', v.readyState, v.videoWidth, v.videoHeight, v.paused);
    c.width = 150; c.height = 75;
    ctx.fillRect(0, 0, 150, 75);
    await new Promise(function (r) { v.onresize = r; });
    log('resized', v.videoWidth, v.videoHeight);
    stream.getTracks()[0].stop();
  `);
  has(logs, 'undrawn|0');
  has(logs, 'drawn|4|300|150|false');
  has(logs, 'resized|150|75');
});

test('getDisplayMedia wants a press, refuses what a page may not require, and fits the screen to what it asks', async () => {
  const logs = await run(
    `
    try { await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch (e) { log('unpressed', e.name); }
    async function refused(o) {
      try { await navigator.mediaDevices.getDisplayMedia(o); return 'made'; } catch (e) { return e.name; }
    }
    log('types', await refused({ video: false }), await refused({ video: { width: { min: 320 } } }),
      await refused({ video: { advanced: [{ width: 320 }] } }), await refused({ systemAudio: 'invalid' }),
      await refused({ video: { displaySurface: 'monitor' }, monitorTypeSurfaces: 'exclude' }));
    log('supported', navigator.mediaDevices.getSupportedConstraints().displaySurface);
    log('press');
    await pressed();
    var controller = new CaptureController();
    var stream = await navigator.mediaDevices.getDisplayMedia({ controller: controller, video: { width: { max: 360 }, frameRate: { max: 4 }, displaySurface: 'window' }, audio: true });
    controller.setFocusBehavior('no-focus-change');
    var again = (function () { try { controller.setFocusBehavior('no-focus-change'); return 'set'; } catch (e) { return e.name; } })();
    log('focus', again, await refused({ controller: controller }), await refused({ controller: {} }));
    var s = stream.getVideoTracks()[0].getSettings();
    log('display', stream.getVideoTracks().length, stream.getAudioTracks().length, s.width, s.height, s.frameRate, s.displaySurface, s.cursor);
    log('audio', stream.getAudioTracks()[0].getSettings().suppressLocalAudioPlayback);
    log('controller', typeof CaptureController, (function () { try { new CaptureController().setFocusBehavior('nope'); } catch (e) { return e.name; } })());
    stream.getTracks().forEach(function (t) { t.stop(); });
  `,
    { mediaDevices: fakeMediaDevices() },
    { press: true },
  );
  has(logs, 'unpressed|InvalidStateError');
  has(logs, 'types|TypeError|TypeError|TypeError|TypeError|TypeError');
  has(logs, 'supported|true');
  has(logs, 'display|1|1|360|203|4|window|never');
  has(logs, 'audio|false');
  has(logs, 'controller|function|TypeError');
  has(logs, 'focus|InvalidStateError|InvalidStateError|TypeError');
});

test('a source is read only while something reads it, one listener however many do', async () => {
  const listens: boolean[] = [];
  let frames = 0;
  let deliver: ((frame: MediaVideoFrame) => void) | undefined;
  const source: MediaSourceLike = {
    kind: 'video',
    label: 'counted',
    listen(events) {
      listens.push(!!events.video);
      deliver = events.video;
      events.muted(false);
    },
    settings: () => ({}),
    capabilities: () => ({}),
    reconfigure: () => Promise.resolve(false),
    stop() {},
  };
  const told: unknown[] = [];
  const sources = new PageSources({
    devices: () => undefined,
    origin: () => 'https://page.test',
    originless: () => false,
    tell: (name, input) => told.push([name, input]),
  });
  const id = sources.register(source);
  assert.deepEqual(listens, [false], 'listened to once, for no frames');
  const one = sources.read(id, () => (frames += 1));
  const two = sources.read(id, () => (frames += 1));
  assert.deepEqual(listens, [false, true], 'asked for frames once');
  const frame: MediaVideoFrame = {
    width: 2,
    height: 2,
    planes: [new Uint8Array(4), new Uint8Array(1), new Uint8Array(1)],
    strides: [2, 1, 1],
    timestamp: 0,
  };
  deliver!(frame);
  assert.equal(frames, 2, 'each reader has the frame');
  let late = 0;
  const three = sources.read(id, () => (late += 1));
  assert.equal(late, 1, 'and one that comes the newest at once');
  three();
  one();
  assert.deepEqual(listens, [false, true]);
  two();
  assert.deepEqual(
    listens,
    [false, true, false],
    'and no more once none reads',
  );
  // the page's media elements watch its size, from a task after they ask:
  // told once it is known
  sources.op('mdSize', id, true);
  await new Promise((r) => setTimeout(r, 0));
  deliver!(frame);
  deliver!(frame);
  assert.deepEqual(told, [['__mdSource', [id, 'size', 2, 2]]]);
});

test('NV12 and BGRA frames come to I420 where a reader needs it, and an I420 one is itself', () => {
  const nv12 = toI420({
    format: 'NV12',
    width: 2,
    height: 2,
    planes: [new Uint8Array([10, 20, 30, 40]), new Uint8Array([100, 200])],
    strides: [2, 2],
    timestamp: 5,
  });
  assert.equal(nv12.format, 'I420');
  assert.deepEqual(
    nv12.planes.map((p) => [...p]),
    [[10, 20, 30, 40], [100], [200]],
  );
  // white and black, blue first: Y 235 and 16, and grey chroma
  const bgra = toI420({
    format: 'BGRA',
    width: 2,
    height: 1,
    planes: [new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255])],
    strides: [8],
    timestamp: 0,
  });
  assert.deepEqual(
    bgra.planes.map((p) => [...p]),
    [[235, 16], [128], [128]],
  );
  const i420: MediaVideoFrame = {
    width: 1,
    height: 1,
    planes: [new Uint8Array(1), new Uint8Array(1), new Uint8Array(1)],
    strides: [1, 1, 1],
    timestamp: 0,
  };
  assert.equal(toI420(i420), i420);
});

nodeTest(
  'coreMediaDevices: core’s devices as the seam has them, with Chrome’s defaults, and a camera that shows itself',
  async () => {
    const app = createMockApp();
    const fakes = coreFakes(app);
    const media = coreMediaDevices(app);
    const devices = await media.devices();
    const camera = devices.find((d) => d.kind === 'videoinput');
    const mic = devices.find((d) => d.kind === 'audioinput');
    assert.ok(camera && mic, JSON.stringify(devices));
    assert.ok(!devices.some((d) => (d.kind as string) === 'systemaudio'));
    assert.equal(camera.defaults.width, 640);
    assert.equal(camera.defaults.frameRate, 30);
    assert.equal(mic.defaults.echoCancellation, true);
    const source = await media.open(camera.deviceId, { width: 320 });
    assert.equal(source.kind, 'video');
    assert.ok(source.present?.(), 'a core track shows itself');
    const live = fakes.last('video')!;
    assert.equal(live.wanted, false, 'and nothing reads its frames yet');
    const got: MediaVideoFrame[] = [];
    source.listen({ video: (f) => got.push(f), muted() {}, ended() {} });
    assert.equal(live.wanted, true, 'until a listener reads them');
    live.tick();
    assert.equal(got.length, 1);
    assert.ok(got[0].width > 0 && got[0].format, JSON.stringify(got[0]));
    source.listen({ muted() {}, ended() {} });
    assert.equal(
      live.wanted,
      false,
      'and a listener that does not lets them go',
    );
    let ended = false;
    source.listen({ muted() {}, ended: () => (ended = true) });
    live.end();
    assert.equal(ended, true, 'its end is told');
    source.stop();
    await assert.rejects(media.open('nope', {}), { name: 'NotFoundError' });
  },
);

test('a page’s camera in a <video> is core’s <video srcObject>, and its sound core’s <audio srcObject>', async () => {
  const logs = await run(
    `
    var stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    var v = document.getElementById('v');
    v.srcObject = stream;
    v.muted = false;
    await v.play();
    await new Promise(function (r) { v.ontimeupdate = r; });
    log('playing', v.videoWidth > 0, v.paused);
  `,
    (app) => {
      coreFakes(app);
      return { mediaDevices: coreMediaDevices(app) };
    },
  );
  has(logs, 'playing|true|false');
  type Mounted = DrawnNode & { props: Record<string, unknown> };
  const [video] = screen.all((n) => n.kind === 'video') as Mounted[];
  assert.ok(video, 'a player is mounted over the video');
  assert.ok(video.props.srcObject, 'showing core’s stream');
  const [audio] = screen.all((n) => n.kind === 'audio') as Mounted[];
  assert.ok(audio?.props.srcObject, 'and its sound played by core');
});

test('an analyser hears a microphone a stream source brings it: the tone’s wave, and its frequency’s peak', async () => {
  const logs = await run(`
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var ctx = new AudioContext();
    await ctx.resume();
    var analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    var gain = ctx.createGain();
    gain.gain.value = 2;
    ctx.createMediaStreamSource(stream).connect(gain);
    gain.connect(analyser);
    var wave = new Float32Array(2048);
    var peak = 0;
    for (var i = 0; i < 100 && peak === 0; i++) {
      await wait(20);
      analyser.getFloatTimeDomainData(wave);
      peak = Math.max.apply(null, Array.from(wave, Math.abs));
    }
    await wait(100);
    analyser.getFloatTimeDomainData(wave);
    peak = Math.max.apply(null, Array.from(wave, Math.abs));
    var bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    var loudest = 0;
    for (var k = 1; k < bins.length; k++) if (bins[k] > bins[loudest]) loudest = k;
    var hz = loudest * ctx.sampleRate / analyser.fftSize;
    log('heard', peak > 0.15 && peak < 0.25, Math.abs(hz - 440) < 50, bins[loudest] > 100);
    stream.getAudioTracks()[0].enabled = false;
    await wait(50);
    analyser.getFloatTimeDomainData(wave);
    log('disabled', Math.max.apply(null, Array.from(wave, Math.abs)));
    stream.getTracks().forEach(function (t) { t.stop(); });
    ctx.close();
  `);
  has(logs, 'heard|true|true|true');
  has(logs, 'disabled|0');
});

test('a <video> of a stream draws onto a canvas, its newest frame, and createImageBitmap reads the same', async () => {
  // the shape of webrtc.github.io's getusermedia/filter sample: the camera
  // in a <video>, and a snapshot drawn from it into a canvas as a press asks
  const logs = await run(`
    var canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    var stream = await navigator.mediaDevices.getUserMedia({ video: true });
    var v = document.getElementById('v');
    v.srcObject = stream;
    await v.play();
    while (v.readyState < 2) await wait(10);
    await wait(100);
    var ctx = canvas.getContext('2d');
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    function at(x, y) { return [].slice.call(ctx.getImageData(x, y, 1, 1).data).join(','); }
    log('white', at(20, 300));
    log('yellow', at(100, 300));
    log('black', at(620, 300));
    var bitmap = await createImageBitmap(v);
    var other = document.createElement('canvas');
    other.width = bitmap.width;
    other.height = bitmap.height;
    var octx = other.getContext('2d');
    octx.drawImage(bitmap, 0, 0);
    log('bitmap', bitmap.width, bitmap.height, octx.getImageData(620, 300, 1, 1).data[3], octx.getImageData(20, 300, 1, 1).data[0]);
    stream.getVideoTracks()[0].enabled = false;
    await wait(50);
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    log('disabled', at(20, 300));
    stream.getTracks().forEach(function (t) { t.stop(); });
  `);
  has(logs, 'white|255,255,255,255');
  has(logs, 'black|0,0,0,255');
  const yellow = logs.find((l) => l.startsWith('yellow|'))!;
  const [r, g, b] = yellow.slice(7).split(',').map(Number);
  assert.ok(r > 230 && g > 230 && b < 40, `a yellow bar: ${yellow}`);
  has(logs, 'bitmap|640|480|255|255');
  has(logs, 'disabled|0,0,0,255');
});

test('a source’s newest frame is held for a canvas only while a media element that can draw it asks', () => {
  const listens: boolean[] = [];
  let deliver: ((frame: MediaVideoFrame) => void) | undefined;
  const source: MediaSourceLike = {
    kind: 'video',
    label: 'held',
    listen(events) {
      listens.push(!!events.video);
      deliver = events.video;
    },
    settings: () => ({}),
    capabilities: () => ({}),
    reconfigure: () => Promise.resolve(false),
    stop() {},
  };
  const sources = new PageSources({
    devices: () => undefined,
    origin: () => 'https://page.test',
    originless: () => false,
    tell: () => {},
  });
  const id = sources.register(source);
  assert.equal(sources.op('mdPixels', id, ''), '', 'nothing held');
  sources.op('mdKeep', id, true);
  assert.deepEqual(listens, [false, true], 'read for the canvas');
  // video range white and black, and the plane reused for the next frame
  const y = new Uint8Array([235, 16, 235, 16]);
  deliver!({
    width: 2,
    height: 2,
    planes: [y, new Uint8Array([128]), new Uint8Array([128])],
    strides: [2, 1, 1],
    timestamp: 0,
  });
  y.fill(0);
  const answer = String(sources.op('mdPixels', id, ''));
  const [head, body] = answer.split('|');
  assert.equal(head, '1,2,2');
  assert.deepEqual(
    [...Buffer.from(body, 'base64')],
    [255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255],
    'the frame as it came, not the plane after it',
  );
  assert.equal(sources.op('mdPixels', id, '1'), '1', 'the same frame again');
  sources.op('mdKeep', id, false);
  assert.deepEqual(listens, [false, true, false], 'and let go');
  assert.equal(sources.op('mdPixels', id, ''), '');
});

test('a <video> of a stream the document draws through a filter is painted by the document, from its frames', async () => {
  if (!FONTS) return;
  const logs = await run(`
    var stream = await navigator.mediaDevices.getUserMedia({ video: true });
    var v = document.getElementById('v');
    v.style.filter = 'invert(1)';
    v.srcObject = stream;
    await v.play();
    while (v.readyState < 2) await wait(10);
    await wait(300);
    var r = v.getBoundingClientRect();
    log('rect', Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height));
  `);
  const rect = logs.find((l) => l.startsWith('rect|'))!;
  const [x, y, w, hgt] = rect.slice(5).split('|').map(Number);
  assert.equal(
    screen.all((n) => n.kind === 'video').length,
    0,
    'no player over a filtered video',
  );
  await act(() => new Promise((r) => setTimeout(r, 100)));
  const row = Math.round(y + hgt * 0.6);
  const left = await pixelsIn(lastRender!.ctx, {
    x: x + 3,
    y: row,
    width: 1,
    height: 1,
  });
  const right = await pixelsIn(lastRender!.ctx, {
    x: x + w - 4,
    y: row,
    width: 1,
    height: 1,
  });
  // the white bar inverted, and the black one
  assert.ok(
    left[0] < 30 && left[1] < 30 && left[2] < 30,
    `the white bar, inverted: ${[...left]}`,
  );
  assert.ok(
    right[0] > 225 && right[1] > 225 && right[2] > 225,
    `the black bar, inverted: ${[...right]}`,
  );
});
