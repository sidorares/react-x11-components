// What a description is checked for, and how its m-sections are paired
// with a connection's transceivers, over werift (`src/html/werift.ts`): a
// browser refuses an answer whose directions its offer does not allow, ICE
// credentials of other characters than ICE's and a description with no DTLS
// fingerprint, and takes one with no mids; a remote offer's m-section is
// paired only with a transceiver `addTrack` made, and only where the
// m-section receives (JSEP 5.10); a rollback keeps what `addTrack` gave a
// track, and takes the tracks it took away out of their streams.
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

test('a rollback keeps a transceiver a remote offer made that addTrack gave a track, though replaceTrack took it since, and takes the tracks it takes away out of their streams', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.addTrack(audioTrack());
    await pc2.setRemoteDescription(await pc1.createOffer());
    log('made', pc2.getTransceivers().length);
    pc2.addTrack(audioTrack());
    await pc2.getTransceivers()[0].sender.replaceTrack(null);
    await pc2.setRemoteDescription({ type: 'rollback' });
    var t = pc2.getTransceivers()[0];
    log('kept', pc2.getTransceivers().length, t && t.mid, t && t.direction);

    var pc3 = new RTCPeerConnection(), pc4 = new RTCPeerConnection();
    var dest = new AudioContext().createMediaStreamDestination();
    pc3.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
    pc3.addTrack(audioTrack(), dest.stream);
    var remote = null;
    pc4.ontrack = function (e) { remote = e.streams[0]; };
    await pc4.setRemoteDescription(await pc3.createOffer());
    var held = remote.getTracks().map(function (x) { return x.id; });
    var removed = [];
    remote.onremovetrack = function (e) { removed.push(e.track.id); };
    await pc4.setRemoteDescription({ type: 'rollback' });
    log('removed', removed.length, held.every(function (id) { return removed.indexOf(id) >= 0; }), remote.getTracks().length, pc4.getTransceivers().length);
    [pc1, pc2, pc3, pc4].forEach(function (pc) { pc.close(); });
    log('done');
  `);
  const line = lines(logs);
  assert.equal(line('made'), 'made|1');
  assert.equal(line('kept'), 'kept|1||sendrecv');
  assert.equal(line('removed'), 'removed|2|true|0|0');
});

/** A page's helpers for descriptions written by hand: what a promise was
 *  refused with, or `taken`, and a description of the given lines. */
const SDP = `
  async function refused(p) {
    try { await p; return 'taken'; } catch (e) { return e.name; }
  }
  function sdp(lines) { return lines.join('\\r\\n') + '\\r\\n'; }
  var SESSION = ['v=0', 'o=- 0 3 IN IP4 127.0.0.1', 's=-', 't=0 0'];
  var FINGERPRINT = 'a=fingerprint:sha-256 A7:24:72:CA:6E:02:55:39:BA:66:DF:6E:CC:4C:D8:B0:1A:BF:1A:56:65:7D:F4:03:AD:7E:77:43:2A:29:EC:93';
  function section(kind, mid, direction, more) {
    return [
      'm=' + kind + ' 9 UDP/TLS/RTP/SAVPF ' + (kind === 'audio' ? '111' : '100'),
      'c=IN IP4 0.0.0.0', 'a=rtcp-mux', 'a=' + direction, 'a=mid:' + mid,
      kind === 'audio' ? 'a=rtpmap:111 opus/48000/2' : 'a=rtpmap:100 VP8/90000',
      'a=setup:actpass',
    ].concat(more || []);
  }
  var ICE = ['a=ice-ufrag:ETEn', 'a=ice-pwd:OtSK0WpNtpUjkY4+86js7Z/l'];
`;

test('a remote description is refused for ICE credentials of other characters than ICE’s, for no DTLS fingerprint, for two m-sections of one track or one SSRC, and an answer for directions or kinds its offer does not allow', async () => {
  const logs = await run(`${SDP}
    var pc = new RTCPeerConnection();
    var offer = function (ice, fingerprint) {
      return { type: 'offer', sdp: sdp(SESSION.concat(fingerprint ? [FINGERPRINT] : [], section('video', 'video', 'sendonly', ice))) };
    };
    log('ice',
      await refused(pc.setRemoteDescription(offer(['a=ice-ufrag:E$En', ICE[1]], true))),
      await refused(new RTCPeerConnection().setRemoteDescription(offer([ICE[0], 'a=ice-pwd:OtSK$WpNtpUjkY4+86js7Z/l'], true))),
      await refused(new RTCPeerConnection().setRemoteDescription(offer(ICE, true))));
    log('fingerprint',
      await refused(new RTCPeerConnection().setRemoteDescription(offer(ICE.concat(['a=crypto:0 AES_CM_128_HMAC_SHA1_80 inline:2nra27hTUb9ilyn2rEkBEQN9WOFts26F/jvofasw']), false))));

    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    var stream = new AudioContext().createMediaStreamDestination().stream;
    a.addTrack(stream.getAudioTracks()[0], stream);
    var made = (await a.createOffer()).sdp;
    var at = made.indexOf('\\r\\nm=') + 2;
    var twice = made + made.slice(at).replace('a=mid:', 'a=mid:unique');
    log('msid', await refused(b.setRemoteDescription({ type: 'offer', sdp: twice })));
    // a section with no track names its SSRCs, which are one source's
    var none = new RTCPeerConnection();
    none.addTransceiver('video');
    var bare = (await none.createOffer()).sdp;
    var again = bare + bare.slice(bare.indexOf('\\r\\nm=') + 2).replace('a=mid:', 'a=mid:unique');
    log('ssrc', await refused(new RTCPeerConnection().setRemoteDescription({ type: 'offer', sdp: again })));

    async function answered(direction, from, to) {
      var p1 = new RTCPeerConnection(), p2 = new RTCPeerConnection();
      p1.addTransceiver('audio').direction = direction;
      await p1.setLocalDescription();
      await p2.setRemoteDescription(p1.localDescription);
      await p2.setLocalDescription();
      return refused(p1.setRemoteDescription({ type: 'answer', sdp: p2.localDescription.sdp.replace(from, to) }));
    }
    log('direction',
      await answered('recvonly', 'inactive', 'recvonly'),
      await answered('sendonly', 'recvonly', 'sendrecv'),
      await answered('sendonly', 'recvonly', 'recvonly'));

    // an unknown kind is no other unknown kind, in an answer either way
    var o = new RTCPeerConnection(), r = new RTCPeerConnection(), q = new RTCPeerConnection();
    o.addTransceiver('audio');
    await r.setRemoteDescription({ type: 'offer', sdp: (await o.createOffer()).sdp.replace('m=audio ', 'm=unicorns ') });
    var answer = await r.createAnswer();
    log('local kind', /m=unicorns 0 /.test(answer.sdp),
      await refused(r.setLocalDescription({ type: 'answer', sdp: answer.sdp.replace('m=unicorns ', 'm=dragons ') })));
    await r.setLocalDescription(answer);
    var reoffer = await r.createOffer();
    await r.setLocalDescription(reoffer);
    await q.setRemoteDescription(reoffer);
    var reanswer = (await q.createAnswer()).sdp;
    log('remote kind', /m=unicorns 0 /.test(reoffer.sdp), /m=unicorns 0 /.test(reanswer),
      await refused(r.setRemoteDescription({ type: 'answer', sdp: reanswer.replace('m=unicorns ', 'm=dragons ') })),
      await refused(r.setRemoteDescription({ type: 'answer', sdp: reanswer })));
    log('done');
  `);
  const line = lines(logs);
  assert.equal(line('ice'), 'ice|InvalidAccessError|InvalidAccessError|taken');
  assert.equal(line('fingerprint'), 'fingerprint|InvalidAccessError');
  assert.equal(line('msid'), 'msid|OperationError');
  assert.equal(line('ssrc'), 'ssrc|OperationError');
  assert.equal(
    line('direction'),
    'direction|InvalidAccessError|InvalidAccessError|taken',
  );
  assert.equal(line('local kind'), 'local kind|true|InvalidModificationError');
  assert.equal(
    line('remote kind'),
    'remote kind|true|true|InvalidAccessError|taken',
  );
});

test('an offer and an answer with no mids are taken, each m-section given the mid of its place or of its offer’s', async () => {
  const logs = await run(`
    function without(d, prefix) {
      return { type: d.type, sdp: d.sdp.split('\\n').filter(function (l) { return l.indexOf(prefix) !== 0; }).join('\\n') };
    }
    var caller = new RTCPeerConnection(), callee = new RTCPeerConnection();
    caller.addTrack(audioTrack());
    var offer = await caller.createOffer();
    await caller.setLocalDescription(offer);
    await callee.setRemoteDescription(without(without(offer, 'a=mid:'), 'a=group:'));
    var answer = await callee.createAnswer();
    await caller.setRemoteDescription(answer);
    log('offer', callee.getTransceivers().length, callee.getTransceivers()[0].mid, caller.signalingState);

    var c2 = new RTCPeerConnection(), d2 = new RTCPeerConnection();
    c2.addTrack(audioTrack());
    var o2 = await c2.createOffer();
    await c2.setLocalDescription(o2);
    await d2.setRemoteDescription(o2);
    var mid = c2.getTransceivers()[0].mid;
    await c2.setRemoteDescription(without(without(await d2.createAnswer(), 'a=mid:'), 'a=group:'));
    log('answer', c2.getTransceivers()[0].mid === mid, c2.getTransceivers()[0].currentDirection);
    log('done');
  `);
  const line = lines(logs);
  assert.equal(line('offer'), 'offer|1|0|stable');
  assert.equal(line('answer'), 'answer|true|sendonly');
});

test('a remote offer’s m-section is paired only with a transceiver addTrack made, and only where it receives, so glare keeps a sendonly transceiver sendonly', async () => {
  const logs = await run(`${SDP}
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.addTransceiver('audio');
    var own = b.addTransceiver('audio');
    var reused = new RTCPeerConnection();
    reused.addTransceiver('audio');
    reused.addTrack(audioTrack());
    var offer = await a.createOffer();
    await b.setRemoteDescription(offer);
    await reused.setRemoteDescription(offer);
    log('addTransceiver', b.getTransceivers().length, own.mid, b.getTransceivers()[1].mid,
      reused.getTransceivers().length, reused.getTransceivers()[0].mid);

    var c = new RTCPeerConnection();
    c.addTrack(audioTrack());
    var t = c.getTransceivers()[0];
    await c.setRemoteDescription({ type: 'offer', sdp: sdp(SESSION.concat([FINGERPRINT], ICE,
      section('audio', '1', 'sendonly'), section('audio', '2', 'recvonly'))) });
    await c.setLocalDescription();
    log('receives', t.mid, c.getTransceivers().length);

    var p1 = new RTCPeerConnection(), p2 = new RTCPeerConnection();
    p1.addTransceiver('audio', { direction: 'sendonly' });
    var s2 = p2.addTransceiver('audio', { direction: 'sendonly' });
    await p1.setLocalDescription();
    await p2.setLocalDescription();
    // the polite peer's offer is rolled back for the impolite one's
    await p2.setRemoteDescription(p1.localDescription);
    await p2.setLocalDescription();
    await p1.setRemoteDescription(p2.localDescription);
    log('glare', s2.direction, s2.mid, p2.getTransceivers().length, p2.getTransceivers()[1].currentDirection);
    log('done');
  `);
  const line = lines(logs);
  assert.equal(line('addTransceiver'), 'addTransceiver|2||0|2|');
  assert.equal(line('receives'), 'receives|2|2');
  assert.equal(line('glare'), 'glare|sendonly||2|recvonly');
});

test('setLocalDescription() sets the last offer or answer created while nothing changed since, and makes another where something did', async () => {
  const logs = await run(`
    var o = new RTCPeerConnection();
    o.addTransceiver('audio');
    var offer = await o.createOffer();
    await o.setLocalDescription();
    log('offer', o.pendingLocalDescription.sdp === offer.sdp);

    var changed = new RTCPeerConnection();
    changed.addTransceiver('audio');
    await changed.createOffer();
    changed.addTransceiver('video');
    await changed.setLocalDescription();
    log('changed', /\\r\\nm=video /.test(changed.pendingLocalDescription.sdp));

    var x = new RTCPeerConnection(), y = new RTCPeerConnection();
    x.addTransceiver('audio');
    await y.setRemoteDescription(await x.createOffer());
    var answer = await y.createAnswer();
    await y.setLocalDescription({ type: 'pranswer', sdp: '' });
    log('pranswer', y.pendingLocalDescription.sdp === answer.sdp, y.signalingState);
    log('done');
  `);
  const line = lines(logs);
  assert.equal(line('offer'), 'offer|true');
  assert.equal(line('changed'), 'changed|true');
  assert.equal(line('pranswer'), 'pranswer|true|have-local-pranswer');
});

test('an m-section stopped and negotiated away carries a transceiver of another kind added after, and an unknown kind’s stays in every offer after, rejected', async () => {
  const logs = await run(`${SDP}
    function sections(d) { return d.sdp.split('\\r\\nm=').length - 1; }
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    async function negotiate() {
      await pc1.setLocalDescription();
      await pc2.setRemoteDescription(pc1.localDescription);
      await pc2.setLocalDescription();
      await pc1.setRemoteDescription(pc2.localDescription);
    }
    pc1.addTransceiver('audio');
    await negotiate();
    pc1.getTransceivers()[0].stop();
    await negotiate();
    var video = pc1.addTransceiver('video');
    await negotiate();
    log('local', sections(pc1.localDescription), video.mid !== null, video.mid !== '0', video.currentDirection,
      /^m=video /m.test(pc2.remoteDescription.sdp));

    var pc3 = new RTCPeerConnection();
    await pc3.setRemoteDescription({ type: 'offer', sdp: sdp(SESSION.concat([FINGERPRINT],
      section('video', 'video', 'sendonly', ICE).map(function (l) { return l.replace('m=video 9', 'm=video 0'); }))) });
    await pc3.setLocalDescription();
    pc3.addTransceiver('audio');
    var reoffer = await pc3.createOffer();
    log('remote', pc3.getTransceivers().length, sections(reoffer), /^m=audio [1-9]/m.test(reoffer.sdp));

    var o = new RTCPeerConnection(), r = new RTCPeerConnection();
    o.addTransceiver('audio');
    await r.setRemoteDescription({ type: 'offer', sdp: (await o.createOffer()).sdp.replace(/^m=audio (\\d+) \\S+/m, 'm=unicorns $1 TCP/DTLS/RTP/SAVPF') });
    await r.setLocalDescription();
    log('unknown', r.getTransceivers().length, /^m=unicorns 0 TCP\\/DTLS\\/RTP\\/SAVPF /m.test((await r.createOffer()).sdp));
    log('done');
  `);
  const line = lines(logs);
  assert.equal(line('local'), 'local|1|true|true|sendonly|true');
  assert.equal(line('remote'), 'remote|1|1|true');
  assert.equal(line('unknown'), 'unknown|0|true');
});

test('an ICE restart’s credentials are ice-chars, which the far side takes', async () => {
  // werift makes them of base64url, whose `-` and `_` are no ice-chars; at
  // five restarts one of them nearly always has one
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.addTransceiver('audio');
    async function negotiate() {
      await pc1.setLocalDescription();
      await pc2.setRemoteDescription(pc1.localDescription);
      await pc2.setLocalDescription();
      await pc1.setRemoteDescription(pc2.localDescription);
    }
    await negotiate();
    var bad = [], ufrags = [];
    for (var i = 0; i < 5; i++) {
      pc1.restartIce();
      await negotiate();
      var sdp = pc1.localDescription.sdp + pc2.localDescription.sdp;
      var lines = sdp.match(/^a=ice-(ufrag|pwd):.*$/gm);
      lines.forEach(function (l) { if (!/^a=ice-(ufrag|pwd):[A-Za-z0-9+\\/]+$/.test(l.trim())) bad.push(l); });
      ufrags.push(/^a=ice-ufrag:(\\S+)/m.exec(pc1.localDescription.sdp)[1]);
    }
    log('restarts', bad.length, new Set(ufrags).size, pc1.signalingState);
    log('done');
  `);
  const line = lines(logs);
  assert.equal(line('restarts'), 'restarts|0|5|stable');
});
