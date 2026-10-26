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
    // werift has gathered its host candidates, and the page has heard of none
    log('described', /a=candidate:/.test(pc1.localDescription.sdp));
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
    var heard = /a=candidate:/.test(pc1.localDescription.sdp);
    var certs = pc1.sctp.transport.getRemoteCertificates();
    log('certificates', heard, certs.length, certs[0] instanceof ArrayBuffer, new Uint8Array(certs[0])[0]);
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
    'described|false',
    'ice|new,checking,connected|new,checking,connected',
    'certificates|true|1|true|48',
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
