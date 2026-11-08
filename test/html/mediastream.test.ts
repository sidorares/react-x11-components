// `<Html scripts>`' Media Capture and Streams (`src/html/scripts/mediastream.ts`,
// the host's half in `media-sources.ts` and `constraints.ts`) as a page sees
// it over the fake devices: what `enumerateDevices` tells a document before
// and after it captures, the settings `getUserMedia` and `applyConstraints`
// come to, the `OverconstrainedError` either rejects with, and the shapes
// Web IDL gives the interfaces. WPT's `mediacapture-streams` runs the same
// through `scripts/conformance/interop.ts`.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import {
  Html,
  fakeMediaDevices,
  preloadHtmlScripts,
} from '../../src/html/index.js';
import type { HtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** A page's scripts over the fake devices, run until one logs `done`:
 *  every line it logged. */
async function run(
  script: string,
  scripts: HtmlScripts = { mediaDevices: fakeMediaDevices() },
): Promise<string[]> {
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source:
        '<script>' +
        'function log() { console.log([].slice.call(arguments).join("|")); }' +
        'function kinds(list) { return list.map(function (d) { return d.kind + ":" + (d.deviceId ? "id" : "") + (d.groupId ? "+group" : "") + (d.label ? "+label" : ""); }).join(","); }' +
        `(async function () { try { ${script} } catch (e) { log("failed", e.name, e.message); } log("done"); })();` +
        '</script>',
      partial: false,
      baseUrl: 'https://page.test/',
      scripts: {
        ...scripts,
        log: (_level: string, text: string) => void logs.push(text),
      },
    }),
    FONTS ? { width: 100, height: 50, fonts: FONTS } : { backend: 'mock' },
  );
  const end = Date.now() + 10000;
  while (!logs.includes('done') && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  assert.ok(
    !logs.some((l) => l.startsWith('failed')),
    `the page failed:\n${logs.join('\n')}`,
  );
  return logs;
}

const expect = (logs: string[], lines: string[]) => {
  for (const line of lines) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
};

test('enumerateDevices tells a document what it captured, and no more: one empty entry a kind before, microphones, cameras and then speakers after', async () => {
  // allowed both kinds, which is not what decides it: Firefox and Safari
  // show a document that has not captured empty entries whatever it may do
  const logs = await run(`
    log('before', kinds(await navigator.mediaDevices.enumerateDevices()));
    var video = await navigator.mediaDevices.getUserMedia({ video: true });
    video.getTracks()[0].stop();
    var after = await navigator.mediaDevices.enumerateDevices();
    log('video', kinds(after));
    var audio = await navigator.mediaDevices.getUserMedia({ audio: true });
    audio.getTracks()[0].stop();
    var both = await navigator.mediaDevices.enumerateDevices();
    log('both', kinds(both));
    var mic = both[0], speaker = both[2], camera = both[1];
    log('groups', mic.groupId === speaker.groupId, mic.groupId === camera.groupId);
    log('ids', camera.deviceId === after[1].deviceId, camera.deviceId.length);
    var caps = camera.getCapabilities();
    log('caps', caps.deviceId === camera.deviceId, caps.groupId === camera.groupId, caps.resizeMode.join());
  `);
  expect(logs, [
    'before|audioinput:,videoinput:',
    'video|audioinput:,videoinput:id+group+label',
    'both|audioinput:id+group+label,videoinput:id+group+label,audiooutput:id+group+label',
    'groups|true|false',
    'ids|true|64',
    'caps|true|true|none,crop-and-scale',
  ]);
});

test('getUserMedia: what no device can meet is an OverconstrainedError naming it, and what it can is met', async () => {
  const logs = await run(`
    async function tryIt(c) {
      try {
        var s = await navigator.mediaDevices.getUserMedia({ video: c });
        var t = s.getVideoTracks()[0], set = t.getSettings();
        t.stop();
        return 'ok ' + set.width + 'x' + set.height + ' ' + set.frameRate + ' ' + set.resizeMode;
      } catch (e) {
        return e.name + ' ' + e.constraint + ' ' + (e instanceof DOMException) + ' ' + (e instanceof OverconstrainedError);
      }
    }
    for (var c of [
      { width: { max: 0 } },
      { frameRate: { min: 100, max: 10 } },
      { facingMode: { exact: '' } },
      { resizeMode: { exact: 'INVALID' } },
      { width: { exact: 639 }, resizeMode: { exact: 'none' } },
      { width: { ideal: 320, min: 160 } },
      { width: { ideal: 400, min: 160 } },
      { resizeMode: { exact: 'crop-and-scale' }, frameRate: { max: 5 } },
      { width: 1280 },
    ]) log(JSON.stringify(c), await tryIt(c));
    var devices = await navigator.mediaDevices.enumerateDevices();
    var mic = devices.filter(function (d) { return d.kind === 'audioinput'; })[0];
    log('group', await tryIt({ groupId: { exact: mic.groupId } }));
    var s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: { exact: 'remote-only' } } });
    log('echo', s.getAudioTracks()[0].getSettings().echoCancellation, s.getAudioTracks()[0].getSettings().voiceIsolation);
  `);
  expect(logs, [
    '{"width":{"max":0}}|OverconstrainedError width true true',
    '{"frameRate":{"min":100,"max":10}}|OverconstrainedError frameRate true true',
    '{"facingMode":{"exact":""}}|OverconstrainedError facingMode true true',
    '{"resizeMode":{"exact":"INVALID"}}|OverconstrainedError resizeMode true true',
    '{"width":{"exact":639},"resizeMode":{"exact":"none"}}|OverconstrainedError width true true',
    '{"width":{"ideal":320,"min":160}}|ok 320x240 30 none',
    '{"width":{"ideal":400,"min":160}}|ok 400x300 30 crop-and-scale',
    '{"resizeMode":{"exact":"crop-and-scale"},"frameRate":{"max":5}}|ok 640x480 5 crop-and-scale',
    '{"width":1280}|ok 1280x720 30 none',
    'group|OverconstrainedError groupId true true',
    'echo|remote-only|false',
  ]);
});

test('applyConstraints sets the track to what it comes to, or rejects naming the one it cannot meet and keeps what it had', async () => {
  const logs = await run(`
    var s = await navigator.mediaDevices.getUserMedia({ video: true });
    var t = s.getVideoTracks()[0];
    function shown() { var x = t.getSettings(); return x.width + 'x' + x.height + ' ' + x.resizeMode; }
    log('start', shown());
    await t.applyConstraints({ width: 400, height: 300 });
    log('scaled', shown(), JSON.stringify(t.getConstraints()));
    try { await t.applyConstraints({ height: { max: -1 } }); } catch (e) { log('refused', e.name, e.constraint, shown(), JSON.stringify(t.getConstraints())); }
    try { await t.applyConstraints({ groupId: { exact: 'INVALID' } }); } catch (e) { log('group', e.name, e.constraint); }
    await t.applyConstraints({ resizeMode: 'INVALID' });
    log('ideal', shown());
    try { await t.applyConstraints(5); } catch (e) { log('type', e.name); }
    t.stop();
    await t.applyConstraints({ width: { exact: 1 } });
    log('ended', 'resolved', shown());
  `);
  expect(logs, [
    'start|640x480 none',
    'scaled|400x300 crop-and-scale|{"width":400,"height":300}',
    'refused|OverconstrainedError|height|400x300 crop-and-scale|{"width":400,"height":300}',
    'group|OverconstrainedError|groupId',
    'ideal|640x480 none',
    'type|TypeError',
    'ended|resolved|640x480 none',
  ]);
});

test('the interfaces are Web IDL’s: mediaDevices on Navigator.prototype, handlers and methods checking what they are called on, DeviceChangeEvent', async () => {
  const logs = await run(`
    var d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'mediaDevices');
    log('navigator', !!d && typeof d.get, Object.prototype.hasOwnProperty.call(navigator, 'mediaDevices'), navigator.mediaDevices instanceof MediaDevices);
    try { d.get.call({}); } catch (e) { log('getter', e.name); }
    var set = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'onended').set;
    try { set.call({}, null); } catch (e) { log('handler', e.name); }
    try { new MediaStream().getTrackById(); } catch (e) { log('arity', e.name); }
    try { MediaDevices.prototype.getSupportedConstraints.call(null); } catch (e) { log('this', e.name); }
    await MediaDevices.prototype.enumerateDevices.call({}).catch(function (e) { log('rejected', e.name); });
    log('voice', navigator.mediaDevices.getSupportedConstraints().voiceIsolation);
    var list = await navigator.mediaDevices.enumerateDevices();
    var ev = new DeviceChangeEvent('devicechange', { devices: list });
    log('event', ev.devices.length === list.length, Object.isFrozen(ev.devices), ev.devices === ev.devices, ev.userInsertedDevices.length);
    try { new DeviceChangeEvent('devicechange', { devices: [{}] }); } catch (e) { log('devices', e.name); }
  `);
  expect(logs, [
    'navigator|function|false|true',
    'getter|TypeError',
    'handler|TypeError',
    'arity|TypeError',
    'this|TypeError',
    'rejected|TypeError',
    'voice|true',
    'event|true|true|true|0',
    'devices|TypeError',
  ]);
});
