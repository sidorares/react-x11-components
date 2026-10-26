// A page's peer connections over the network's own seam, `HtmlNetwork`'s
// (`src/html/werift.ts`), end to end: two `RTCPeerConnection`s in one page,
// as WPT's tests make them, offering, answering and trickling candidates to
// each other over werift until both are connected. What
// `webrtc-peer.test.ts` holds of the page's API over a fake stack, this
// holds of the adapter.
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
 *  `done` or `failed`. */
async function run(script: string): Promise<string[]> {
  const logs: string[] = [];
  const network = new HtmlNetwork();
  await renderX11(
    h(Html, {
      source:
        '<script>' +
        'function log() { console.log([].slice.call(arguments).join("|")); }' +
        `(async function () { try { ${script} } catch (e) { log("failed", e.name, e.message); } })();` +
        '</script>',
      partial: false,
      baseUrl: 'https://page.test/',
      scripts: {
        webRTC: network.webRTC,
        timeout: 10000,
        log: (_level: string, text: string) => void logs.push(text),
      },
    }),
    FONTS ? { width: 100, height: 50, fonts: FONTS } : { backend: 'mock' },
  );
  const end = Date.now() + 20000;
  while (!logs.some((l) => /^(done|failed)\|?/.test(l)) && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }
  return logs;
}

test('two peers in one page offer, answer, trickle their candidates and connect', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var states = [];
    pc1.onconnectionstatechange = function () { states.push(pc1.connectionState); };
    var ends = 0;
    pc1.onicecandidate = function (e) {
      if (!e.candidate) { ends++; return; }
      pc2.addIceCandidate(e.candidate);
    };
    pc2.onicecandidate = function (e) { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    var tracks = [];
    pc2.ontrack = function (e) { tracks.push(e.track.kind + ':' + e.streams.length); };
    var t = pc1.addTransceiver('audio');
    var negotiation = new Promise(function (r) { pc1.onnegotiationneeded = r; });
    await negotiation;
    log('negotiation', pc1.signalingState);
    await pc1.setLocalDescription();
    log('offered', pc1.signalingState, pc1.localDescription.type, /m=audio/.test(pc1.localDescription.sdp), t.mid);
    await pc2.setRemoteDescription(pc1.localDescription);
    log('remote', pc2.signalingState, pc2.getTransceivers().length, pc2.getTransceivers()[0].direction);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
    log('answered', pc1.signalingState, pc2.signalingState, t.currentDirection, pc2.getTransceivers()[0].currentDirection);
    var end = Date.now() + 10000;
    while (pc1.connectionState !== 'connected' || pc2.connectionState !== 'connected') {
      if (Date.now() > end) throw new Error('not connected: ' + pc1.connectionState + ' ' + pc2.connectionState);
      await new Promise(function (r) { setTimeout(r, 20); });
    }
    log('connected', pc1.iceConnectionState, pc2.iceConnectionState, states.join(','));
    log('transport', t.sender.transport.state, t.sender.transport.iceTransport.state, t.sender.transport === t.receiver.transport);
    var codecs = t.sender.getParameters().codecs.map(function (c) { return c.mimeType; });
    log('codecs', codecs.join(','));
    log('tracks', tracks.join(','));
    while (pc1.iceGatheringState !== 'complete') await new Promise(function (r) { setTimeout(r, 20); });
    await new Promise(function (r) { setTimeout(r, 0); });
    log('gathered', ends);
    pc1.close(); pc2.close();
    log('done', pc1.signalingState, pc1.connectionState);
  `);
  assert.ok(
    !logs.some((l) => l.startsWith('failed')),
    `a step failed: ${logs.join('\n')}`,
  );
  const line = (prefix: string) =>
    logs.find((l) => l.startsWith(`${prefix}|`)) ?? `${prefix}: missing`;
  assert.equal(line('negotiation'), 'negotiation|stable');
  assert.equal(line('offered'), 'offered|have-local-offer|offer|true|0');
  assert.equal(line('remote'), 'remote|have-remote-offer|1|recvonly');
  assert.equal(line('answered'), 'answered|stable|stable|sendonly|recvonly');
  assert.match(
    line('connected'),
    /^connected\|(connected|completed)\|(connected|completed)\|connecting,connected$/,
  );
  assert.equal(line('transport'), 'transport|connected|connected|true');
  assert.equal(
    line('codecs'),
    'codecs|audio/opus,audio/PCMU,audio/PCMA,audio/telephone-event',
  );
  assert.equal(line('tracks'), 'tracks|audio:0');
  assert.equal(line('gathered'), 'gathered|1');
  assert.equal(line('done'), 'done|closed|closed');
});

test('data channels: a close delivers what was queued, a negotiated channel opens late, and a lost peer is an sctp-failure', async () => {
  const logs = await run(`
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }
    async function until(what, f) {
      for (var end = Date.now() + 10000; !f(); await wait(10)) {
        if (Date.now() > end) throw new Error('never ' + what);
      }
    }
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = function (e) { if (e.candidate) pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = function (e) { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    function announced() {
      return new Promise(function (r) { pc2.ondatachannel = function (e) { r(e.channel); }; });
    }
    var dc1 = pc1.createDataChannel('x');
    var remote = announced();
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
    var dc2 = await remote;
    await until('open', function () { return dc1.readyState === 'open' && dc2.readyState === 'open'; });

    // 4 MiB sent and closed at once: all of it arrives before the close
    var received = 0, events1 = [], events2 = [];
    dc2.binaryType = 'arraybuffer';
    dc2.onmessage = function (e) { received += e.data.byteLength; };
    ['closing', 'close', 'error'].forEach(function (type) {
      dc1.addEventListener(type, function () { events1.push(type); });
      dc2.addEventListener(type, function () { events2.push(type); });
    });
    var chunk = new Uint8Array(64 * 1024);
    for (var i = 0; i < 64; i++) dc1.send(chunk);
    dc1.close();
    await until('closed', function () { return dc1.readyState === 'closed' && dc2.readyState === 'closed'; });
    log('delivered', received, events1.join(','), events2.join(','));

    // negotiated once the association is up: open, and carrying messages
    var n1 = pc1.createDataChannel('n', { negotiated: true, id: 10 });
    var n2 = pc2.createDataChannel('n', { negotiated: true, id: 10 });
    await until('negotiated open', function () { return n1.readyState === 'open' && n2.readyState === 'open'; });
    var echoed = new Promise(function (r) { n2.onmessage = function (e) { r(e.data); }; });
    n1.send('hello');
    log('negotiated', await echoed);

    // the peer goes: an sctp-failure, then the close
    var ended = [];
    n2.onerror = function (e) {
      ended.push('error:' + (e.error instanceof RTCError) + ':' + e.error.errorDetail + ':' + e.error.sctpCauseCode);
    };
    n2.onclose = function () { ended.push('close'); };
    pc1.close();
    await until('peer gone', function () { return n2.readyState === 'closed'; });
    log('ended', ended.join(','));
    pc2.close();
    log('done');
  `);
  assert.ok(
    !logs.some((l) => l.startsWith('failed')),
    `a step failed: ${logs.join('\n')}`,
  );
  for (const line of [
    `delivered|${4 * 1024 * 1024}|close|closing,close`,
    'negotiated|hello',
    'ended|error:true:sctp-failure:null,close',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('transports: ICE goes new, checking, connected on both sides, the SCTP transport is told, and the stats name it all', async () => {
  const logs = await run(`
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }
    async function until(what, f) {
      for (var end = Date.now() + 10000; !f(); await wait(10)) {
        if (Date.now() > end) throw new Error('never ' + what);
      }
    }
    async function transportStats(pc) {
      var found = null;
      (await pc.getStats()).forEach(function (s) { if (s.type === 'transport') found = s; });
      return found;
    }
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var ice1 = [pc1.iceConnectionState], ice2 = [pc2.iceConnectionState];
    pc1.oniceconnectionstatechange = function () { ice1.push(pc1.iceConnectionState); };
    pc2.oniceconnectionstatechange = function () { ice2.push(pc2.iceConnectionState); };
    pc1.onicecandidate = function (e) { if (e.candidate) pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = function (e) { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    pc1.createDataChannel('x');
    await pc1.setLocalDescription();
    var early = await transportStats(pc1);
    log('early', early.iceState, early.iceRole, early.dtlsState, early.dtlsRole, early.selectedCandidatePairChanges);
    var sctp = [];
    pc1.sctp.onstatechange = function () { sctp.push(pc1.sctp.state + ':' + (pc1.sctp.maxChannels > 0)); };
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
    await until('connected', function () { return pc1.sctp.state === 'connected' && pc2.sctp && pc2.sctp.state === 'connected'; });
    log('sctp', sctp.join(','), pc1.sctp.maxChannels === pc2.sctp.maxChannels);
    await until('ice', function () { return ice1[ice1.length - 1] === 'connected' && ice2[ice2.length - 1] === 'connected'; });
    log('ice', ice1.join(','), ice2.join(','));
    var up = await transportStats(pc1);
    log('up', up.iceState, up.iceRole, up.dtlsState, up.dtlsRole === 'client' || up.dtlsRole === 'server', up.tlsVersion, /^SRTP_/.test(up.srtpCipher), up.selectedCandidatePairChanges);
    var closed = new Promise(function (r) { pc2.sctp.onstatechange = function () { if (pc2.sctp.state === 'closed') r(); }; });
    pc1.close();
    await closed;
    log('closed', pc2.sctp.state);
    pc2.close();
    log('done');
  `);
  assert.ok(
    !logs.some((l) => l.startsWith('failed')),
    `a step failed: ${logs.join('\n')}`,
  );
  for (const line of [
    'early|new|controlling|new|unknown|0',
    'sctp|connected:true|true',
    'ice|new,checking,connected|new,checking,connected',
    'up|connected|controlling|connected|true|FEFD|true|1',
    'closed|closed',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('what werift cannot read is an RTCError of sdp-syntax-error, as a browser has it', async () => {
  const logs = await run(`
    var pc = new RTCPeerConnection();
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: 'not sdp' });
      log('accepted');
    } catch (e) {
      log('refused', e instanceof RTCError, e.name, e.errorDetail, e.sdpLineNumber, pc.signalingState);
    }
    pc.close();
    log('done');
  `);
  assert.ok(
    logs.includes('refused|true|OperationError|sdp-syntax-error|1|stable'),
    logs.join('\n'),
  );
});

test('a certificate generateCertificate makes is the one a connection offers', async () => {
  const logs = await run(`
    var cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    var fp = cert.getFingerprints()[0];
    log('certificate', cert instanceof RTCCertificate, cert.expires > Date.now(), fp.algorithm);
    var pc = new RTCPeerConnection({ certificates: [cert] });
    pc.addTransceiver('audio');
    var offer = await pc.createOffer();
    log('offered', offer.sdp.toLowerCase().indexOf('a=fingerprint:' + fp.algorithm + ' ' + fp.value.toLowerCase()) >= 0);
    pc.close();
    log('done');
  `);
  assert.ok(logs.includes('certificate|true|true|sha-256'), logs.join('\n'));
  assert.ok(logs.includes('offered|true'), logs.join('\n'));
});

test('a transceiver stopped by a remote offer, or taken away by its rollback, is stopped as WebRTC 1.0 has it', async () => {
  const logs = await run(`
    async function negotiate(a, b) {
      await a.setLocalDescription();
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription();
      await a.setRemoteDescription(b.localDescription);
    }
    function state(t) { return [t.mid === null ? 'null' : 'mid', t.direction, t.currentDirection].join(' '); }
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    var ta = a.addTransceiver('audio');
    await negotiate(a, b);
    var tb = b.getTransceivers()[0];
    ta.stop();
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    log('remotely stopped', b.getTransceivers().length, state(tb), tb.receiver.track.readyState);
    await b.setLocalDescription();
    log('answered', b.getTransceivers().length, state(tb));
    await new Promise(function (r) { setTimeout(r, 0); });
    log('ended', tb.receiver.track.readyState);

    var c = new RTCPeerConnection(), d = new RTCPeerConnection();
    c.addTransceiver('video');
    var offer = await c.createOffer();
    await d.setRemoteDescription(offer);
    var made = d.getTransceivers()[0];
    var canvas = document.createElement('canvas');
    await made.sender.replaceTrack(canvas.captureStream().getVideoTracks()[0]);
    await d.setRemoteDescription({ type: 'rollback' });
    log('rolled back', d.getTransceivers().length, state(made));
    await d.setRemoteDescription(offer);
    var again = d.getTransceivers()[d.getTransceivers().length - 1];
    d.addTrack(canvas.captureStream().getVideoTracks()[0]);
    await d.setRemoteDescription({ type: 'rollback' });
    log('kept by addTrack', d.getTransceivers().length, d.getTransceivers()[0] === again, state(again), again.receiver.transport);

    var e = new RTCPeerConnection(), f = new RTCPeerConnection();
    e.addTransceiver('audio');
    await e.setLocalDescription();
    await f.setRemoteDescription(e.localDescription);
    var answer = await f.createAnswer();
    var tf = f.getTransceivers()[0];
    tf.stop();
    await f.setLocalDescription(answer);
    log('stopped after the answer was made', state(tf));
    [a, b, c, d, e, f].forEach(function (pc) { pc.close(); });
    log('done');
  `);
  for (const line of [
    'remotely stopped|1|mid stopped stopped|live',
    'answered|0|null stopped stopped',
    'ended|ended',
    'rolled back|0|null stopped stopped',
    'kept by addTrack|1|true|null sendrecv |',
    'stopped after the answer was made|mid stopped recvonly',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('a remote description with bare LF line endings is read, and one that moves a header extension’s id is refused', async () => {
  const logs = await run(`
    var pc = new RTCPeerConnection();
    var sdp = 'v=0\\no=- 0 3 IN IP4 127.0.0.1\\ns=-\\nt=0 0\\n' +
      'a=fingerprint:sha-256 A7:24:72:CA:6E:02:55:39:BA:66:DF:6E:CC:4C:D8:B0:1A:BF:1A:56:65:7D:F4:03:AD:7E:77:43:2A:29:EC:93\\n' +
      'a=ice-ufrag:6HHHdzzeIhkE0CKj\\na=ice-pwd:XYDGVpfvklQIEnZ6YnyLsAew\\na=group:BUNDLE audio video\\r\\n' +
      'm=audio 9 RTP/SAVPF 111\\nc=IN IP4 0.0.0.0\\na=rtcp-mux\\na=sendonly\\na=mid:audio\\na=rtpmap:111 opus/48000/2\\na=setup:actpass\\n' +
      'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid\\r\\n' +
      'm=video 9 RTP/SAVPF 112\\nc=IN IP4 0.0.0.0\\na=rtcp-mux\\na=sendonly\\na=mid:video\\na=rtpmap:112 VP8/90000\\na=setup:actpass\\n' +
      'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid\\r\\n';
    await pc.setRemoteDescription({ type: 'offer', sdp: sdp });
    var answer = await pc.createAnswer();
    log('mixed endings', pc.getTransceivers().map(function (t) { return t.mid; }).join(','), (answer.sdp.match(/a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid/g) || []).length);
    pc.close();

    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.addTransceiver('audio');
    for (var round = 0; round < 2; round++) {
      await a.setLocalDescription();
      await b.setRemoteDescription(a.localDescription);
      var reply = await b.createAnswer();
      if (round === 0) {
        await b.setLocalDescription(reply);
        await a.setRemoteDescription(b.localDescription);
      }
    }
    var swapped = reply.sdp.replace('urn:ietf:params:rtp-hdrext:ssrc-audio-level', 'xyzzy')
      .replace('urn:ietf:params:rtp-hdrext:sdes:mid', 'urn:ietf:params:rtp-hdrext:ssrc-audio-level')
      .replace('xyzzy', 'urn:ietf:params:rtp-hdrext:sdes:mid');
    try { await a.setRemoteDescription({ type: 'answer', sdp: swapped }); log('reassigned', 'taken'); }
    catch (e) { log('reassigned', e.name, e instanceof DOMException); }
    log('still', a.signalingState);
    a.close(); b.close();
    log('done');
  `);
  for (const line of [
    'mixed endings|audio,video|2',
    'reassigned|InvalidAccessError|true',
    'still|have-local-offer',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('a remote offer’s m-section of a kind nothing reads is rejected with port 0, as its own kind', async () => {
  const logs = await run(`
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.addTransceiver('audio');
    a.addTransceiver('video');
    var offer = await a.createOffer();
    await b.setRemoteDescription({ type: 'offer', sdp: offer.sdp.replace('m=audio ', 'm=unicorns ') });
    var answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    var lines = answer.sdp.split('\\r\\n').filter(function (l) { return l.indexOf('m=') === 0; });
    log('answered', lines.length, /^m=unicorns 0 /.test(lines[0]), /^m=video [1-9]/.test(lines[1]));
    log('remote kept', /m=unicorns /.test(b.remoteDescription.sdp), b.getTransceivers().map(function (t) { return t.receiver.track.kind; }).join(','));
    a.close(); b.close();
    log('done');
  `);
  for (const line of ['answered|2|true|true', 'remote kept|true|video']) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});
