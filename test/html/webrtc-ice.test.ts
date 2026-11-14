// An ICE restart over werift (`src/html/werift-transports.ts`) and the
// page's view of it (`src/html/scripts/rtc-transports.ts`,
// `src/html/scripts/webrtc.ts`): a restart's local description gathers, its
// transport and the connection going `gathering` and `complete` again, with
// its candidates in the new credentials; the answer that commits it gathers
// nothing the page hears; a transport's state and the connection's are both
// set before either's event fires; and `restartIce()` holds until an answer
// leaves no old credentials, a rolled-back offer among what it outlives.
//
// Skipped where werift, the optional peer, is not installed or does not
// load, and on Node before 22, which werift does not run on.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, HtmlNetwork, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { loadWerift } from '../../src/html/werift.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const runtime = process as unknown as {
  versions: { node: string; bun?: string };
};
const supported =
  !!runtime.versions.bun || Number(runtime.versions.node.split('.')[0]) >= 22;
const werift = supported ? await loadWerift() : null;
const test = SCRIPTS_CONTAINED && werift ? nodeTest : nodeTest.skip;

/** A page's scripts over werift: what they log, once one line starts with
 *  `done` or `failed`. The limit is on how long they go without logging,
 *  not on how long they take, so a busy machine is not a failure. */
async function run(script: string): Promise<string[]> {
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source:
        '<script>' +
        'function log() { console.log([].slice.call(arguments).join("|")); }' +
        'function audioTrack() { return new AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0]; }' +
        `(async function () { try { ${script} } catch (e) { log("failed", e.name, e.message); } })();` +
        '</script>',
      partial: false,
      baseUrl: 'https://page.test/',
      scripts: {
        webRTC: new HtmlNetwork().webRTC,
        timeout: 10000,
        log: (_level: string, text: string) => void logs.push(text),
      },
    }),
    FONTS ? { width: 100, height: 50, fonts: FONTS } : { backend: 'mock' },
  );
  let heard = 0;
  let end = 0;
  while (!logs.some((l) => /^(done|failed)\|?/.test(l))) {
    if (logs.length > heard || !end) {
      heard = logs.length;
      end = Date.now() + 20000;
    }
    if (Date.now() >= end) break;
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }
  return logs;
}

function lines(logs: string[]): (prefix: string) => string {
  assert.ok(
    !logs.some((l) => l.startsWith('failed')),
    `a step failed: ${logs.join('\n')}`,
  );
  return (prefix) =>
    logs.find((l) => l.startsWith(`${prefix}|`)) ?? `${prefix}: missing`;
}

test('an ICE restart’s local description gathers again in the new credentials, and the answer that commits it tells nothing more', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var events = [];
    pc1.onicegatheringstatechange = function () { events.push('pc:' + pc1.iceGatheringState); };
    pc1.onicecandidate = function (e) {
      if (e.candidate) pc2.addIceCandidate(e.candidate);
      events.push(e.candidate === null ? 'null' : e.candidate.candidate === '' ? 'end:' + e.candidate.usernameFragment : 'cand:' + e.candidate.usernameFragment);
    };
    pc2.onicecandidate = function (e) { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    pc1.addTransceiver('audio', { direction: 'recvonly' });
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
    while (pc1.iceGatheringState !== 'complete') await new Promise(function (r) { setTimeout(r, 20); });
    var ice = pc1.getTransceivers()[0].receiver.transport.iceTransport;
    var first = ice.getLocalParameters().usernameFragment;
    ice.ongatheringstatechange = function () { events.push('t:' + ice.gatheringState + '/' + pc1.iceGatheringState); };
    events.length = 0;
    await pc1.setLocalDescription(await pc1.createOffer({ iceRestart: true }));
    for (var i = 0; i < 100 && events.indexOf('null') < 0; i++) await new Promise(function (r) { setTimeout(r, 20); });
    var ufrag = ice.getLocalParameters().usernameFragment;
    var restart = events.map(function (e) { return e.split(ufrag).join('NEW'); }).join(',');
    log('restart', ufrag !== first, restart.replace(/(cand:NEW,)+/, 'cand:NEW+,'));
    events.length = 0;
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
    await new Promise(function (r) { setTimeout(r, 500); });
    log('committed', events.join(',') || 'nothing', pc1.iceGatheringState, ice.gatheringState, ice.getLocalParameters().usernameFragment === ufrag);
    pc1.close(); pc2.close();
    log('done');
  `);
  const line = lines(logs);
  // the transport's event reads the connection's state as it is now
  assert.equal(
    line('restart'),
    'restart|true|t:gathering/gathering,pc:gathering,cand:NEW+,end:NEW,t:complete/complete,pc:complete,null',
  );
  assert.equal(line('committed'), 'committed|nothing|complete|complete|true');
});

test('restartIce() outlives a restart’s offer that is rolled back, and goes with the answer that leaves no old credentials', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    function ufrag(d) { return /^a=ice-ufrag:(\\S+)/m.exec(d.sdp)[1]; }
    async function needed() {
      var heard = false;
      pc1.onnegotiationneeded = function () { heard = true; };
      await new Promise(function (r) { setTimeout(r, 100); });
      return heard;
    }
    pc1.addTransceiver('audio');
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
    var old = ufrag(pc1.localDescription);
    pc1.restartIce();
    await pc1.setLocalDescription();
    var offered = ufrag(pc1.localDescription);
    var again = needed();
    await pc1.setLocalDescription({ type: 'rollback' });
    log('rolled back', offered !== old, await again);
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    var settled = needed();
    await pc1.setRemoteDescription(pc2.localDescription);
    log('answered', ufrag(pc1.localDescription) !== old, await settled);
    pc1.close(); pc2.close();
    log('done');
  `);
  const line = lines(logs);
  assert.equal(line('rolled back'), 'rolled back|true|true');
  assert.equal(line('answered'), 'answered|true|false');
});
