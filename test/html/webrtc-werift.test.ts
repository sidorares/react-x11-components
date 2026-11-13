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
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, HtmlNetwork, preloadHtmlScripts } from '../../src/html/index.js';
import type { HtmlWebRTC } from '../../src/html/index.js';
import type {
  RTCConnectionEvents,
  RTCDataChannelInitLike,
} from '../../src/html/rtc.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { WeriftTransports } from '../../src/html/werift-transports.js';
import type { WTransportsPeer } from '../../src/html/werift-transports.js';
import { loadWerift, weriftWebRTC } from '../../src/html/werift.js';
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
 *  `done` or `failed`. The limit is on how long they go without logging, not
 *  on how long they take, so a busy machine is not a failure. */
async function run(
  script: string,
  webRTC: HtmlWebRTC = new HtmlNetwork().webRTC,
): Promise<string[]> {
  const logs: string[] = [];
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
        webRTC,
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

/** The first SCTP DATA chunk of the given message on a channel of the first
 *  connection made, left out the first time it is sent, as a receive buffer
 *  that overflowed leaves it out: SCTP has to send it again. */
async function losingAChunkOf(message: number): Promise<HtmlWebRTC> {
  const seam = await weriftWebRTC();
  let made = 0;
  let lost = false;
  return {
    ...seam,
    connect(request, events) {
      const connection = seam.connect(request, events);
      if (made++ > 0) return connection;
      const { createDataChannel } = connection;
      connection.createDataChannel = (init) => {
        const channel = createDataChannel.call(connection, init);
        const { sctp } = (connection as unknown as WithAssociation)._pc
          .sctpTransport;
        const { sendChunk } = sctp;
        sctp.sendChunk = function (chunk) {
          if (chunk.streamSeqNum !== message || lost) {
            return sendChunk.call(this, chunk);
          }
          lost = true;
          return Promise.resolve();
        };
        return channel;
      };
      return connection;
    },
  };
}

/** What of a connection's werift `losingAChunkOf` replaces. */
interface WithAssociation {
  _pc: {
    sctpTransport: {
      sctp: {
        sendChunk(chunk: { streamSeqNum?: number }): Promise<void>;
      };
    };
  };
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

test('with max-bundle only the first m-section lists candidates, and an audio sender can send DTMF once connected', async () => {
  const logs = await run(`
    var pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    pc.addTransceiver('audio');
    pc.addTransceiver('audio');
    pc.addTransceiver('video');
    pc.createDataChannel('channel');
    await pc.setLocalDescription();
    while (pc.iceGatheringState !== 'complete') await new Promise(function (r) { setTimeout(r, 20); });
    var sections = pc.localDescription.sdp.split(/\\r\\nm=/).slice(1);
    log('candidates', sections.map(function (m) { return (m.match(/a=candidate:/g) || []).length > 0; }).join(','));
    pc.close();
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = function (e) { if (e.candidate) b.addIceCandidate(e.candidate); };
    b.onicecandidate = function (e) { if (e.candidate) a.addIceCandidate(e.candidate); };
    // a sender with no track sends no DTMF
    var dest = new AudioContext().createMediaStreamDestination();
    var dtmf = a.addTrack(dest.stream.getAudioTracks()[0], dest.stream).dtmf;
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription);
    var end = Date.now() + 10000;
    while (!dtmf.canInsertDTMF && Date.now() < end) await new Promise(function (r) { setTimeout(r, 20); });
    log('dtmf', a.connectionState, dtmf.canInsertDTMF);
    a.close(); b.close();
    log('done');
  `);
  assert.ok(
    !logs.some((l) => l.startsWith('failed')),
    `a step failed: ${logs.join('\n')}`,
  );
  const line = (prefix: string) =>
    logs.find((l) => l.startsWith(`${prefix}|`)) ?? `${prefix}: missing`;
  assert.equal(line('candidates'), 'candidates|true,false,false,false');
  assert.equal(line('dtmf'), 'dtmf|connected|true');
});

test('a message the far side sends from its datachannel handler, ahead of its ACK, opens the channel and arrives', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = function (e) { if (e.candidate) pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = function (e) { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    pc2.ondatachannel = function (e) { e.channel.send('meow'); };
    var dc1 = pc1.createDataChannel('fire-me!');
    var order = [];
    dc1.onopen = function () { order.push('open'); };
    var got = new Promise(function (r) { dc1.onmessage = function (e) { order.push(e.data); r(); }; });
    await pc1.setLocalDescription(); await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(); await pc1.setRemoteDescription(pc2.localDescription);
    await Promise.race([got, new Promise(function (r) { setTimeout(r, 8000); })]);
    log('heard', order.join(','));
    pc1.close(); pc2.close();
    log('done');
  `);
  const line = (prefix: string) =>
    logs.find((l) => l.startsWith(`${prefix}|`)) ?? `${prefix}: missing`;
  assert.equal(line('heard'), 'heard|open,meow');
});

test('a transport checks nothing before it has one of the peer’s candidates, and checks once it is handed one', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var sender = pc1.addTransceiver('audio').sender;
    var first = new Promise(function (r) { pc2.onicecandidate = function (e) { if (e.candidate) r(e.candidate); }; });
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription({ type: 'offer', sdp: pc1.localDescription.sdp.replace(/a=candidate:[^\\r\\n]*\\r\\n/g, '') });
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription({ type: 'answer', sdp: pc2.localDescription.sdp.replace(/a=candidate:[^\\r\\n]*\\r\\n/g, '') });
    await new Promise(function (r) { setTimeout(r, 300); });
    var ice = sender.transport.iceTransport;
    log('answered', ice.state);
    var states = [];
    ice.onstatechange = function () { states.push(ice.state); };
    await pc1.addIceCandidate(await first);
    var end = Date.now() + 8000;
    while (!states.length && Date.now() < end) await new Promise(function (r) { setTimeout(r, 20); });
    log('handed', states[0]);
    pc1.close(); pc2.close();
    log('done');
  `);
  const line = (prefix: string) =>
    logs.find((l) => l.startsWith(`${prefix}|`)) ?? `${prefix}: missing`;
  assert.equal(line('answered'), 'answered|new');
  assert.equal(line('handed'), 'handed|checking');
});

test('a channel the far side closes in its datachannel handler opens on neither side, and a channel has its id from the association up', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = function (e) { if (e.candidate) pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = function (e) { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    var opened = [];
    pc2.ondatachannel = function (e) {
      var d = e.channel;
      d.onopen = function () { opened.push('far'); };
      d.close();
    };
    var dc1 = pc1.createDataChannel('fire-me!');
    await pc1.setLocalDescription(); await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(); await pc1.setRemoteDescription(pc2.localDescription);
    while (pc1.sctp.state !== 'connected') await new Promise(function (r) { pc1.sctp.addEventListener('statechange', r, { once: true }); });
    var dc2 = pc1.createDataChannel('another');
    log('ids', typeof dc1.id, typeof dc2.id, dc1.id !== dc2.id, dc1.id % 2 === dc2.id % 2);
    await new Promise(function (r) { setTimeout(r, 500); });
    log('opened', opened.join(',') || 'none');
    pc1.close(); pc2.close();
    log('done');
  `);
  const line = (prefix: string) =>
    logs.find((l) => l.startsWith(`${prefix}|`)) ?? `${prefix}: missing`;
  assert.equal(line('ids'), 'ids|number|number|true|true');
  assert.equal(line('opened'), 'opened|none');
});

test('a transport that only hears the peer’s checks finds it peer-reflexive and checks before it connects', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = function (e) { if (e.candidate) pc2.addIceCandidate(e.candidate); };
    pc1.addTransceiver('audio');
    var states = [pc1.iceConnectionState];
    pc1.oniceconnectionstatechange = function () { states.push(pc1.iceConnectionState); };
    await pc1.setLocalDescription(); await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription({ type: 'answer', sdp: pc2.localDescription.sdp.replace(/a=candidate:[^\\r\\n]*\\r\\n/g, '') });
    var end = Date.now() + 8000;
    while (pc1.iceConnectionState !== 'connected' && Date.now() < end) await new Promise(function (r) { setTimeout(r, 20); });
    log('states', states.join(','));
    pc1.close(); pc2.close();
    log('done');
  `);
  const line = (prefix: string) =>
    logs.find((l) => l.startsWith(`${prefix}|`)) ?? `${prefix}: missing`;
  assert.match(line('states'), /^states\|new,checking,connected/);
});

test('a peer-reflexive remote candidate is hidden from the page, in the selected pair and in the stats, and a signalled one is not', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = function (e) { if (e.candidate) pc2.addIceCandidate(e.candidate); };
    var t1 = pc1.addTransceiver('audio');
    await pc1.setLocalDescription(); await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    // pc1 never hears of pc2's candidates: it finds pc2 from its checks
    await pc1.setRemoteDescription({ type: 'answer', sdp: pc2.localDescription.sdp.replace(/a=candidate:[^\\r\\n]*\\r\\n/g, '') });
    var end = Date.now() + 8000;
    while ((pc1.iceConnectionState !== 'connected' || pc2.iceConnectionState !== 'connected') && Date.now() < end) await new Promise(function (r) { setTimeout(r, 20); });
    var pair = t1.sender.transport.iceTransport.getSelectedCandidatePair();
    var r = pair.remote;
    log('pair', r.candidate === '', r.type, r.address === null, typeof r.port, typeof r.priority, r.protocol, r.component, r.relatedAddress === null, typeof r.relatedPort, pair.local.type, pair.local.address !== null);
    var stats = []; (await pc1.getStats()).forEach(function (s) { if (s.type === 'remote-candidate') stats.push(s); });
    log('stats', stats.length > 0, stats.every(function (s) { return s.candidateType === 'prflx' && s.address === null && s.usernameFragment === undefined; }));
    // pc2 was told pc1's candidates: what it reached is what it was told
    var other = pc2.getTransceivers()[0].sender.transport.iceTransport.getSelectedCandidatePair().remote;
    log('signalled', other.candidate !== '', other.type, other.address !== null);
    var stats2 = []; (await pc2.getStats()).forEach(function (s) { if (s.type === 'remote-candidate' && s.candidateType !== 'prflx') stats2.push(s); });
    log('signalled stats', stats2.length > 0, stats2.every(function (s) { return s.address !== null; }));
    pc1.close(); pc2.close();
    log('done');
  `);
  const line = (prefix: string) =>
    logs.find((l) => l.startsWith(`${prefix}|`)) ?? `${prefix}: missing`;
  assert.equal(
    line('pair'),
    'pair|true|prflx|true|number|number|udp|rtp|true|number|host|true',
  );
  assert.equal(line('stats'), 'stats|true|true');
  assert.equal(line('signalled'), 'signalled|true|host|true');
  assert.equal(line('signalled stats'), 'signalled stats|true|true');
});

test('a TCP candidate werift cannot use is ignored, in a description and in addIceCandidate, and checks nothing, and a UDP one written with its a= is used', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.addTransceiver('audio');
    await pc1.setLocalDescription();
    var tcp = 'candidate:2983561038 1 tcp 1518214911 127.0.0.1 9 typ host tcptype passive generation 0';
    var offer = pc1.localDescription.sdp.replace(/a=candidate:[^\\r\\n]*\\r\\n/g, '').replace(/(a=mid:[^\\r\\n]*\\r\\n)/, '$1a=' + tcp + '\\r\\n');
    await pc2.setRemoteDescription({ type: 'offer', sdp: offer });
    await pc2.setLocalDescription();
    var states = [];
    pc2.oniceconnectionstatechange = function () { states.push(pc2.iceConnectionState); };
    await pc2.addIceCandidate({ candidate: tcp.replace(' 9 ', ' 8001 '), sdpMid: pc2.getTransceivers()[0].mid });
    log('added');
    await new Promise(function (r) { setTimeout(r, 500); });
    log('tcp', pc2.iceConnectionState, states.join(',') || 'none', pc2.getTransceivers()[0].receiver.transport.iceTransport.state);
    // a candidate with its SDP framing's a= is taken as the attribute it frames
    var udp = pc1.localDescription.sdp.match(/a=candidate:[^\\r\\n]* udp [^\\r\\n]*/)[0];
    await pc2.addIceCandidate({ candidate: udp, sdpMid: pc2.getTransceivers()[0].mid });
    var end = Date.now() + 3000;
    while (!states.length && Date.now() < end) await new Promise(function (r) { setTimeout(r, 20); });
    log('prefixed', udp.slice(0, 12), states[0]);
    pc1.close(); pc2.close();
    log('done');
  `);
  assert.ok(logs.includes('added'), logs.join('\n'));
  assert.ok(logs.includes('tcp|new|none|new'), logs.join('\n'));
  assert.ok(logs.includes('prefixed|a=candidate:|checking'), logs.join('\n'));
});

test('a STUN or TURN server that does not resolve, or resolves where nothing reaches, is an icecandidateerror naming a host candidate', async (t) => {
  t.mock.method(dns.promises, 'lookup', (host: string) =>
    host.endsWith('.invalid')
      ? Promise.reject(
          Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }),
        )
      : Promise.resolve([
          { address: host, family: host.includes(':') ? 6 : 4 },
        ]),
  );
  const logs = await run(`
    var pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:0.0.0.1', 'stun:stun.invalid:3478'] }, { urls: 'turns:turn.invalid', username: 'u', credential: 'p' }, { urls: 'stun:127.0.0.1:9' }] });
    var errors = [];
    pc.onicecandidateerror = function (e) {
      errors.push([e.url, e.errorCode, e instanceof RTCPeerConnectionIceErrorEvent, /[.:]/.test(e.address), typeof e.port].join(','));
    };
    pc.addTransceiver('audio');
    await pc.setLocalDescription();
    var end = Date.now() + 5000;
    while (errors.length < 3 && Date.now() < end) await new Promise(function (r) { setTimeout(r, 20); });
    await new Promise(function (r) { setTimeout(r, 200); });
    log('errors', errors.sort().join(';'));
    // the same gathering is not checked again
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(function (r) { setTimeout(r, 200); });
    log('again', errors.length);
    pc.close();
    log('done');
  `);
  const line = (prefix: string) =>
    logs.find((l) => l.startsWith(`${prefix}|`)) ?? `${prefix}: missing`;
  assert.equal(
    line('errors'),
    'errors|stun:0.0.0.1,701,true,true,number;stun:stun.invalid:3478,701,true,true,number;turns:turn.invalid?transport=tcp,701,true,true,number',
  );
  assert.equal(line('again'), 'again|3');
});

test('a certificate’s stats hold its DER, which hashes to the fingerprint they name, on both sides', async () => {
  const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = function (e) { if (e.candidate) pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = function (e) { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    pc1.createDataChannel('x');
    await pc1.setLocalDescription(); await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(); await pc1.setRemoteDescription(pc2.localDescription);
    while (pc1.sctp.transport.state !== 'connected') await new Promise(function (r) { setTimeout(r, 20); });
    (await pc1.getStats()).forEach(function (s) {
      if (s.type === 'certificate') log('certificate', s.fingerprintAlgorithm, s.fingerprint, s.base64Certificate);
    });
    pc1.close(); pc2.close();
    log('done');
  `);
  const certificates = logs.filter((l) => l.startsWith('certificate|'));
  assert.equal(certificates.length, 2, logs.join('\n'));
  for (const l of certificates) {
    const [, algorithm, fingerprint, base64] = l.split('|');
    assert.equal(algorithm, 'sha-256');
    const digest = createHash('sha256')
      .update(Buffer.from(base64, 'base64'))
      .digest('hex');
    assert.equal(digest, fingerprint.replace(/:/g, '').toLowerCase());
  }
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

    // More than SCTP's first window, sent and closed at once: all of it arrives
    // before the close. How long that takes is the machine's, so nothing here
    // is timed: each message logged is what \`run\` waits on
    var received = 0, events1 = [], events2 = [];
    dc2.binaryType = 'arraybuffer';
    dc2.onmessage = function (e) { received += e.data.byteLength; log('received', received); };
    ['closing', 'close', 'error'].forEach(function (type) {
      dc1.addEventListener(type, function () { events1.push(type); });
      dc2.addEventListener(type, function () { events2.push(type); });
    });
    var chunk = new Uint8Array(16 * 1024);
    for (var i = 0; i < 8; i++) dc1.send(chunk);
    dc1.close();
    while (dc1.readyState !== 'closed' || dc2.readyState !== 'closed') await wait(10);
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
    `delivered|${8 * 16 * 1024}|close|closing,close`,
    'negotiated|hello',
    'ended|error:true:sctp-failure:null,close',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('a close waits for what SCTP has to send again, which its reset would overtake', async () => {
  const logs = await run(
    `
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }
    async function until(what, f) {
      for (var end = Date.now() + 10000; !f(); await wait(10)) {
        if (Date.now() > end) throw new Error('never ' + what);
      }
    }
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = function (e) { if (e.candidate) pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = function (e) { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    var dc1 = pc1.createDataChannel('x');
    var remote = new Promise(function (r) { pc2.ondatachannel = function (e) { r(e.channel); }; });
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
    var dc2 = await remote;
    await until('open', function () { return dc1.readyState === 'open' && dc2.readyState === 'open'; });
    var received = 0;
    dc2.binaryType = 'arraybuffer';
    dc2.onmessage = function (e) { received += e.data.byteLength; };
    var chunk = new Uint8Array(16 * 1024);
    dc1.send(chunk);
    dc1.send(chunk);
    dc1.close();
    await until('closed', function () { return dc1.readyState === 'closed' && dc2.readyState === 'closed'; });
    log('delivered', received);
    pc1.close(); pc2.close();
    log('done');
  `,
    // the channel's open message is its stream's message 0
    await losingAChunkOf(2),
  );
  assert.ok(
    logs.includes(`delivered|${2 * 16 * 1024}`),
    `delivered less, or nothing: ${logs.join('\n')}`,
  );
});

nodeTest(
  'a close waits on its own stream alone, and is made whatever state the channel is in',
  () => {
    const silent = { subscribe() {} };
    const flushes: (() => void)[] = [];
    const sentQueue = [{ streamId: 3 }, { streamId: 1 }];
    let closed = 0;
    // its open message unacknowledged, and a neighbour's chunk in flight
    const channel = {
      id: 1,
      readyState: 'connecting',
      bufferedAmount: 0,
      bufferedAmountLow: silent,
      stateChanged: silent,
      onMessage: silent,
      error: silent,
      close: () => void closed++,
    };
    const transports = new WeriftTransports(
      {
        onIceCandidate: silent,
        onDataChannel: silent,
        iceGatheringStateChange: silent,
        iceConnectionStateChange: silent,
        connectionStateChange: silent,
        sctpTransport: {
          sctp: {
            flush: { subscribe: (f: () => void) => flushes.push(f) },
            outboundQueue: [],
            sentQueue,
          },
        },
        createDataChannel: () => channel,
      } as unknown as WTransportsPeer,
      {} as RTCConnectionEvents,
      () => false,
    );
    const made = transports.channel({
      id: null,
      maxPacketLifeTime: null,
      maxRetransmits: null,
    } as RTCDataChannelInitLike);
    made.close();
    assert.equal(closed, 0, 'closed with its own chunk unacknowledged');
    sentQueue.pop();
    for (const flush of flushes) flush();
    assert.equal(closed, 1, 'held up by a neighbour, or by connecting');
  },
);

test('a page that names no STUN server asks none, where werift asks Google', async (t) => {
  const asked: string[] = [];
  t.mock.method(dns.promises, 'lookup', (host: string) => {
    asked.push(host);
    return Promise.reject(new Error('no network here'));
  });
  const logs = await run(`
    var pc = new RTCPeerConnection();
    var gathered = new Promise(function (r) {
      pc.onicecandidate = function (e) { if (!e.candidate) r(); };
    });
    pc.createDataChannel('x');
    await pc.setLocalDescription();
    await gathered;
    pc.close();
    log('done');
  `);
  assert.ok(logs.includes('done'), logs.join('\n'));
  assert.deepEqual(asked, []);
});

test('a STUN server a page names is asked, in its constructor or in setConfiguration, and one it takes away is not', async (t) => {
  const server = dgram.createSocket('udp4');
  t.after(() => server.close());
  let asked = 0;
  // RFC 8489's Binding success response: the transaction echoed, and an
  // XOR-MAPPED-ADDRESS of 203.0.113.7
  server.on('message', (request, from) => {
    asked++;
    const reply = Buffer.alloc(32);
    reply.writeUInt16BE(0x0101, 0);
    reply.writeUInt16BE(12, 2);
    request.copy(reply, 4, 4, 20);
    reply.writeUInt16BE(0x0020, 20);
    reply.writeUInt16BE(8, 22);
    reply.writeUInt16BE(0x0001, 24);
    reply.writeUInt16BE(from.port ^ 0x2112, 26);
    reply.writeUInt32BE((0xcb007107 ^ 0x2112a442) >>> 0, 28);
    server.send(reply, from.port, from.address);
  });
  await new Promise<void>((r) => server.bind(0, '127.0.0.1', r));
  const url = `stun:127.0.0.1:${server.address().port}`;
  const logs = await run(`
    async function reflexive(pc) {
      var found = false;
      var gathered = new Promise(function (r) {
        pc.onicecandidate = function (e) {
          if (!e.candidate) r();
          else if (e.candidate.type === 'srflx') found = true;
        };
      });
      pc.createDataChannel('x');
      await pc.setLocalDescription();
      await gathered;
      pc.close();
      return found;
    }
    var servers = [{ urls: ${JSON.stringify(url)} }];
    log('constructor', await reflexive(new RTCPeerConnection({ iceServers: servers })));
    var pc = new RTCPeerConnection();
    pc.setConfiguration({ iceServers: servers });
    log('setConfiguration', await reflexive(pc));
    var taken = new RTCPeerConnection({ iceServers: servers });
    taken.createDataChannel('first');
    taken.setConfiguration({ iceServers: [] });
    log('taken away', await reflexive(taken));
    log('done');
  `);
  for (const line of [
    'constructor|true',
    'setConfiguration|true',
    'taken away|false',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
  assert.ok(asked >= 2, `asked ${asked} times`);
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
    // a machine with two addresses has two pairs, the first to pass its check
    // and then the one nominated, so a page hears the pair change twice
    log('up', up.iceState, up.iceRole, up.dtlsState, up.dtlsRole === 'client' || up.dtlsRole === 'server', up.tlsVersion, /^SRTP_/.test(up.srtpCipher), up.selectedCandidatePairChanges >= 1);
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
    'up|connected|controlling|connected|true|FEFD|true|true',
    'closed|closed',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('a data channel handed to a worker is the worker’s, and an empty message arrives as one', async () => {
  const logs = await run(`
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }
    async function until(what, f) {
      for (var end = Date.now() + 10000; !f(); await wait(10)) {
        if (Date.now() > end) throw new Error('never ' + what);
      }
    }
    var source = [
      'onmessage = function (e) {',
      '  if (!e.data.channel) return;',
      '  var c = e.data.channel;',
      '  postMessage("adopted:" + (c instanceof RTCDataChannel) + ":" + c.label + ":" + c.readyState);',
      '  c.onopen = function () { postMessage("opened"); };',
      '  c.onmessage = function (m) { postMessage("got:" + JSON.stringify(m.data)); c.send("echo:" + m.data); };',
      '};',
    ].join('\\n');
    var worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    var heard = [];
    worker.onmessage = function (e) { heard.push(e.data); };
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = function (e) { if (e.candidate) pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = function (e) { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    var dc = pc1.createDataChannel('moved');
    worker.postMessage({ channel: dc }, [dc]);
    log('moved', dc.readyState);
    var remote = new Promise(function (r) { pc2.ondatachannel = function (e) { r(e.channel); }; });
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
    var dc2 = await remote;
    await until('open', function () { return dc2.readyState === 'open' && heard.indexOf('opened') >= 0; });
    var echoed = new Promise(function (r) { dc2.onmessage = function (e) { r(e.data); }; });
    dc2.send('hi');
    log('echoed', await echoed);
    echoed = new Promise(function (r) { dc2.onmessage = function (e) { r(e.data); }; });
    dc2.send('');
    log('empty', JSON.stringify(await echoed));
    log('worker', heard.join(','));
    var late = pc1.createDataChannel('late');
    await wait(0);
    try { worker.postMessage({ channel: late }, [late]); log('late', 'transferred'); }
    catch (e) { log('late', e.name, e instanceof DOMException, e.constructor.constructor === Function); }
    worker.terminate();
    pc1.close(); pc2.close();
    log('done');
  `);
  assert.ok(
    !logs.some((l) => l.startsWith('failed')),
    `a step failed: ${logs.join('\n')}`,
  );
  for (const line of [
    'moved|closed',
    'echoed|echo:hi',
    'empty|"echo:"',
    'worker|adopted:true:moved:connecting,opened,got:"hi",got:""',
    'late|DataCloneError|true|true',
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

test('a transceiver stopped while its offer is still to be applied keeps its transport, which connects', async () => {
  const logs = await run(`
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = function (e) { if (e.candidate) b.addIceCandidate(e.candidate); };
    b.onicecandidate = function (e) { if (e.candidate) a.addIceCandidate(e.candidate); };
    a.addTransceiver('audio');
    b.addTransceiver('audio');
    var offer = await a.createOffer();
    var stopped = a.getTransceivers()[0];
    stopped.stop();
    await b.setRemoteDescription(offer);
    await a.setLocalDescription(offer);
    var answer = await b.createAnswer();
    await a.setRemoteDescription(answer);
    await b.setLocalDescription(answer);
    for (var i = 0; i < 200 && !(/connected|completed/.test(a.iceConnectionState) && /connected|completed/.test(b.iceConnectionState)); i++) {
      await new Promise(function (r) { setTimeout(r, 20); });
    }
    log('connected', a.iceConnectionState, b.iceConnectionState, stopped.direction, stopped.currentDirection);
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription);
    log('renegotiated', a.getTransceivers().length, b.getTransceivers().length);
    a.close(); b.close();
    log('done');
  `);
  for (const line of [
    'connected|connected|connected|stopped|sendrecv',
    'renegotiated|0|0',
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

test('a remote offer’s rejected m-section is a transceiver stopped at once, which fires no track and goes with the answer', async () => {
  const logs = await run(`
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.addTransceiver('audio');
    a.addTransceiver('video');
    var offer = await a.createOffer();
    var tracks = 0;
    b.ontrack = function () { tracks++; };
    await b.setRemoteDescription({ type: 'offer', sdp: offer.sdp.replace(/m=audio \\d+/, 'm=audio 0') });
    var list = b.getTransceivers();
    log('offered', list.length, list.map(function (t) { return t.receiver.track.kind + ':' + t.direction + ':' + t.currentDirection; }).join(','), tracks);
    await b.setLocalDescription();
    log('answered', b.getTransceivers().length, list[0].mid === null, list[0].currentDirection, b.getTransceivers()[0] === list[1]);
    a.close(); b.close();
    log('done');
  `);
  for (const line of [
    'offered|2|audio:stopped:stopped,video:recvonly:null|1',
    'answered|1|true|stopped|true',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

/** What a page's two peers need to send media to each other: a call set up
 *  the way WPT's helpers set one up, and a wait that gives up. */
const CALL = `
  function wait(what, test, ms) {
    var end = Date.now() + (ms || 15000);
    return new Promise(function (resolve, reject) {
      (function look() {
        var got = test();
        if (got) return resolve(got);
        if (Date.now() > end) return reject(new Error('timed out waiting for ' + what));
        setTimeout(look, 20);
      })();
    });
  }
  async function call(pc1, pc2) {
    pc1.onicecandidate = function (e) { pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = function (e) { pc1.addIceCandidate(e.candidate); };
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
  }
`;

test('Opus flows both ways: a remote track unmutes on its first packet, and its sources and stats are the packets’', async () => {
  const logs = await run(`
    ${CALL}
    var start = performance.timeOrigin + performance.now();
    var ctx = new AudioContext();
    var osc = ctx.createOscillator();
    var dst = ctx.createMediaStreamDestination();
    osc.connect(dst); osc.start();
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var track = dst.stream.getAudioTracks()[0];
    var t1 = pc1.addTransceiver(track, { direction: 'sendrecv' });
    var remote = null, unmuted = 0;
    pc2.ontrack = function (e) {
      remote = e.track;
      log('track', e.track.muted);
      e.track.onunmute = function () { unmuted++; };
    };
    await call(pc1, pc2);
    pc2.getTransceivers()[0].sender.replaceTrack(track.clone());
    pc2.getTransceivers()[0].direction = 'sendrecv';
    await call(pc2, pc1);
    await wait('unmute', function () { return unmuted; });
    log('unmuted', remote.muted);
    var r2 = pc2.getReceivers()[0];
    var ssrcs = await wait('ssrcs', function () {
      var s = r2.getSynchronizationSources();
      return s.length && s[0].audioLevel !== undefined ? s : null;
    });
    var s = ssrcs[0];
    var now = performance.timeOrigin + performance.now();
    log('ssrc', typeof s.source, s.timestamp >= start && s.timestamp <= now,
      s.rtpTimestamp >= 0 && s.rtpTimestamp <= 0xffffffff,
      s.audioLevel > 0 && s.audioLevel <= 1, r2.getContributingSources().length);
    await wait('back', function () { return !t1.receiver.track.muted; });
    var sent = await t1.sender.getStats();
    var out = [...sent.values()].find(function (x) { return x.type === 'outbound-rtp'; });
    log('outbound', !!out && out.packetsSent > 0, out && out.kind, out && out.mid,
      [...sent.values()].some(function (x) { return x.type === 'transport'; }));
    var got = await r2.getStats();
    var inb = [...got.values()].find(function (x) { return x.type === 'inbound-rtp'; });
    log('inbound', !!inb && inb.packetsReceived > 0, inb && inb.trackIdentifier === remote.id,
      [...got.values()].some(function (x) { return x.type === 'outbound-rtp'; }));
    var all = await pc2.getStats();
    log('pc', [...all.values()].filter(function (x) { return /bound-rtp$/.test(x.type); }).map(function (x) { return x.type; }).sort().join(','));
    log('energy', inb.totalAudioEnergy > 0, inb.totalSamplesReceived > 0, inb.nackCount, inb.packetsDiscarded);
    var source = sent.get(out.mediaSourceId);
    log('source', source.kind, source.totalAudioEnergy > 0, source.totalSamplesDuration > 0);
    // RTCP's reports, which werift sends a second or so apart
    var reported = null;
    for (var i = 0; i < 60 && !reported; i++) {
      var r = [...(await pc1.getStats()).values()];
      var ri = r.find(function (x) { return x.type === 'remote-inbound-rtp' && x.roundTripTime !== undefined; });
      var ro = [...(await pc2.getStats()).values()].find(function (x) { return x.type === 'remote-outbound-rtp' && x.remoteTimestamp !== undefined; });
      if (ri && ro) reported = [ri, ro];
      else await new Promise(function (r) { setTimeout(r, 100); });
    }
    log('reports', !!reported && reported[0].localId === out.id);
    // a jitter buffer target holds each packet's samples that long
    async function inboundOf() {
      return [...(await r2.getStats()).values()].find(function (x) { return x.type === 'inbound-rtp'; });
    }
    r2.jitterBufferTarget = 300;
    await new Promise(function (r) { setTimeout(r, 500); });
    var before = await inboundOf();
    await new Promise(function (r) { setTimeout(r, 1000); });
    var after = await inboundOf();
    var held = 1000 * (after.jitterBufferDelay - before.jitterBufferDelay) /
      (after.jitterBufferEmittedCount - before.jitterBufferEmittedCount);
    log('held', Math.abs(held - 300) < 60 ? 'about 300' : held);
    var muted = 0;
    remote.onmute = function () { muted++; };
    pc1.close();
    await wait('quiet', function () { return muted; }, 8000).catch(function () {});
    log('quiet', remote.muted, muted);
    pc2.close();
    track.stop();
    log('done');
  `);
  if (process.env.WERIFT_LOGS) console.log(logs.join('\n'));
  for (const line of [
    'track|true',
    'unmuted|false',
    'ssrc|number|true|true|true|0',
    'outbound|true|audio|0|true',
    'inbound|true|true|false',
    'pc|inbound-rtp,outbound-rtp',
    'energy|true|true|0|0',
    'source|audio|true|true',
    'reports|true',
    'held|about 300',
    'quiet|true|1',
    'done',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('an offer the page changed before it set it, as Meet does with simulcast and header extensions, is set, and the call connects and plays what werift sends', async () => {
  // Meet adds to each video sender's section a SIM group of three SSRCs,
  // each with its RTX in a FID group, and extensions at ids the bundle
  // leaves free, then sets the offer: Chrome takes it, and WebRTC 1.0's
  // InvalidModificationError ended the call before it started
  const logs = await run(`
    ${CALL}
    var canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    document.documentElement.appendChild(canvas);
    var g = canvas.getContext('2d');
    var n = 0;
    var timer = setInterval(function () { n++; g.fillStyle = 'rgb(' + (n * 20 % 255) + ',80,120)'; g.fillRect(0, 0, 160, 120); }, 100);
    var stream = canvas.captureStream();
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.addTrack(stream.getVideoTracks()[0], stream);
    var video = document.createElement('video');
    video.autoplay = true;
    document.documentElement.appendChild(video);
    var metadata = new Promise(function (r) { video.onloadedmetadata = r; });
    pc2.ontrack = function (e) { video.srcObject = e.streams[0]; };
    pc1.onicecandidate = function (e) { pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = function (e) { pc1.addIceCandidate(e.candidate); };
    var BREAK = String.fromCharCode(13, 10);
    var offer = await pc1.createOffer();
    var sections = offer.sdp.split(BREAK + 'm=').map(function (x, i) { return i ? 'm=' + x : x; });
    var munged = sections.map(function (section) {
      if (section.indexOf('m=video') !== 0) return section;
      var fid = /a=ssrc-group:FID ([0-9]+) ([0-9]+)/.exec(section);
      var cname = section.split('a=ssrc:' + fid[1] + ' cname:')[1].split(BREAK)[0];
      var lines = section.split(BREAK).filter(function (l) { return l; });
      lines.push('a=extmap:12 http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time');
      lines.push('a=ssrc-group:SIM ' + fid[1] + ' 1111 2222');
      [[1111, 3333], [2222, 4444]].forEach(function (pair) {
        lines.push('a=ssrc-group:FID ' + pair[0] + ' ' + pair[1]);
        lines.push('a=ssrc:' + pair[0] + ' cname:' + cname);
        lines.push('a=ssrc:' + pair[1] + ' cname:' + cname);
      });
      return lines.join(BREAK);
    }).join(BREAK);
    if (munged.slice(-2) !== BREAK) munged += BREAK;
    await pc1.setLocalDescription({ type: 'offer', sdp: munged });
    log('set', pc1.signalingState);
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
    await wait('connected', function () { return pc1.connectionState === 'connected' && pc2.connectionState === 'connected'; });
    log('connected');
    await Promise.race([metadata, wait('metadata', function () { return false; })]);
    log('metadata', video.videoWidth, video.videoHeight);
    clearInterval(timer);
    pc1.close(); pc2.close();
    log('done');
  `);
  for (const line of [
    'set|have-local-offer',
    'connected',
    'metadata|160|120',
    'done',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('VP8 flows from a canvas into a remote <video>, which loads its metadata at the canvas’s size and plays', async () => {
  const logs = await run(`
    ${CALL}
    var canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    document.documentElement.appendChild(canvas);
    var g = canvas.getContext('2d');
    var n = 0;
    var timer = setInterval(function () {
      n++;
      g.fillStyle = 'rgb(' + (n * 20 % 255) + ',80,120)';
      g.fillRect(0, 0, 320, 240);
      g.fillStyle = 'white';
      g.fillRect(n % 300, 20, 20, 20);
    }, 100);
    var stream = canvas.captureStream();
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.addTrack(stream.getVideoTracks()[0], stream);
    var video = document.createElement('video');
    video.autoplay = true;
    document.documentElement.appendChild(video);
    var metadata = new Promise(function (r) { video.onloadedmetadata = r; });
    var remote = null;
    pc2.ontrack = function (e) { remote = e.track; video.srcObject = e.streams[0]; };
    await call(pc1, pc2);
    await wait('unmute', function () { return remote && !remote.muted; });
    log('unmuted');
    await Promise.race([metadata, wait('metadata', function () { return false; })]);
    log('metadata', video.videoWidth, video.videoHeight, video.readyState);
    var t0 = video.currentTime;
    await new Promise(function (r) { setTimeout(r, 600); });
    log('playing', video.currentTime > t0);
    var settings = remote.getSettings();
    log('settings', settings.width, settings.height);
    var inbound = [...(await pc2.getStats()).values()].find(function (x) { return x.type === 'inbound-rtp'; });
    log('inbound', inbound.kind, inbound.packetsReceived > 0);
    log('decoded', inbound.framesDecoded > 0, inbound.framesReceived >= inbound.framesDecoded, inbound.frameWidth, inbound.frameHeight, inbound.decoderImplementation);
    var sent = await pc1.getStats();
    var out = [...sent.values()].find(function (x) { return x.type === 'outbound-rtp'; });
    var source = sent.get(out.mediaSourceId);
    log('encoded', out.framesEncoded > 0, out.framesSent > 0, out.keyFramesEncoded > 0, out.frameWidth, source.width, source.frames > 0);
    clearInterval(timer);
    pc1.close(); pc2.close();
    log('done');
  `);
  if (process.env.WERIFT_LOGS) console.log(logs.join('\n'));
  for (const line of [
    'unmuted',
    'metadata|320|240|4',
    'playing|true',
    'inbound|video|true',
    'decoded|true|true|320|240|libvpx',
    'encoded|true|true|true|320|320|true',
    'done',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('a disabled track sends black VP8 frames and silent Opus, and an ended one sends nothing, while a clone of each keeps its source alive', async () => {
  const logs = await run(`
    ${CALL}
    var canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    var g = canvas.getContext('2d');
    var n = 0;
    var timer = setInterval(function () { g.fillStyle = n++ % 2 ? '#fff' : '#fafafa'; g.fillRect(0, 0, 160, 120); }, 50);
    var video = canvas.captureStream().getVideoTracks()[0];
    var ctx = new AudioContext();
    var osc = ctx.createOscillator();
    var dst = ctx.createMediaStreamDestination();
    osc.connect(dst); osc.start();
    var audio = dst.stream.getAudioTracks()[0];
    var clones = [video.clone(), audio.clone()];
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.addTrack(video);
    pc1.addTrack(audio);
    var remote = {};
    pc2.ontrack = function (e) { remote[e.track.kind] = e.track; };
    await call(pc1, pc2);
    await wait('unmute', function () { return remote.video && !remote.video.muted && remote.audio && !remote.audio.muted; });
    var shown = document.createElement('video');
    shown.srcObject = new MediaStream([remote.video]);
    var out = document.createElement('canvas');
    out.width = 160; out.height = 120;
    var pen = out.getContext('2d');
    function red() { pen.drawImage(shown, 0, 0, 160, 120); return pen.getImageData(80, 60, 1, 1).data[0]; }
    var receiver = pc2.getReceivers().find(function (r) { return r.track.kind === 'audio'; });
    function level() {
      var s = receiver.getSynchronizationSources()[0];
      return s && s.audioLevel !== undefined ? s.audioLevel : -1;
    }
    async function packets() {
      var got = {};
      for (var s of (await pc2.getStats()).values()) if (s.type === 'inbound-rtp') got[s.kind] = s.packetsReceived;
      return got;
    }
    await wait('picture', function () { return red() > 200 && level() > 0.5; });
    log('enabled', red() > 200, level() > 0.5);
    video.enabled = false;
    audio.enabled = false;
    await wait('black', function () { return red() < 20 && level() >= 0 && level() < 0.001; });
    log('disabled', red() < 20, level() < 0.001);
    video.enabled = true;
    audio.enabled = true;
    await wait('picture again', function () { return red() > 200 && level() > 0.5; });
    log('enabled again');
    video.stop();
    audio.stop();
    await new Promise(function (r) { setTimeout(r, 300); });
    var before = await packets();
    await new Promise(function (r) { setTimeout(r, 1000); });
    var after = await packets();
    log('ended', after.video - before.video, after.audio - before.audio);
    // and nothing more arrives, so the far side mutes
    await wait('muted', function () { return remote.video.muted && remote.audio.muted; }, 8000);
    log('muted', clones[0].readyState, clones[1].readyState);
    clearInterval(timer);
    clones.forEach(function (t) { t.stop(); });
    pc1.close(); pc2.close();
    ctx.close();
    log('done');
  `);
  if (process.env.WERIFT_LOGS) console.log(logs.join('\n'));
  for (const line of [
    'enabled|true|true',
    'disabled|true|true',
    'enabled again',
    'ended|0|0',
    'muted|live|live',
    'done',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('an RTCRtpScriptTransform on each side sees every VP8 frame in its worker, and what it writes back is what is sent and decoded', async () => {
  const logs = await run(`
    ${CALL}
    // a worker that inverts every byte past a frame's first ten on the way
    // out and back on the way in, and says what it saw
    var source = [
      'onrtctransform = function (e) {',
      '  var t = e.transformer, name = t.options.name, seen = 0;',
      '  var r = t.readable.getReader(), w = t.writable.getWriter();',
      '  t.options.port.postMessage("started:" + name + ":" + (e instanceof RTCTransformEvent) + ":" + (t instanceof RTCRtpScriptTransformer));',
      '  t.options.port.onmessage = async function (m) {',
      '    if (m.data === "key") {',
      '      try { t.options.port.postMessage("key:" + typeof (await t.generateKeyFrame())); }',
      '      catch (x) { t.options.port.postMessage("key:" + x.name); }',
      '    }',
      '    if (m.data === "pli") {',
      '      try { await t.sendKeyFrameRequest(); t.options.port.postMessage("pli:ok"); }',
      '      catch (x) { t.options.port.postMessage("pli:" + x.name); }',
      '    }',
      '  };',
      '  (async function () {',
      '    for (;;) {',
      '      var got = await r.read();',
      '      if (got.done) return;',
      '      var f = got.value, m = f.getMetadata();',
      '      if (seen++ === 0) t.options.port.postMessage("first:" + name + ":" + (f instanceof RTCEncodedVideoFrame) + ":" + f.type + ":" + m.mimeType + ":" + m.width + "x" + m.height + ":" + (f.timestamp === m.rtpTimestamp) + ":" + (name === "sender" ? typeof m.captureTime : typeof m.receiveTime));',
      '      var bytes = new Uint8Array(f.data);',
      '      for (var i = 10; i < bytes.length; i++) bytes[i] ^= 0xff;',
      '      var data = f.data;',
      '      w.write(f);',
      '      if (seen === 1) t.options.port.postMessage("detached:" + name + ":" + data.byteLength + ":" + f.data.byteLength);',
      '      w.write(f);',
      '    }',
      '  })();',
      '};',
    ].join('\\n');
    var worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    function transform(name) {
      var channel = new MessageChannel();
      var heard = [];
      channel.port1.onmessage = function (e) { heard.push(e.data); };
      var made = new RTCRtpScriptTransform(worker, { name: name, port: channel.port2 }, [channel.port2]);
      return { made: made, heard: heard, port: channel.port1 };
    }
    var sending = transform('sender'), receiving = transform('receiver');
    var canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    document.documentElement.appendChild(canvas);
    var g = canvas.getContext('2d');
    var n = 0;
    var timer = setInterval(function () {
      n++;
      g.fillStyle = 'rgb(' + (n * 20 % 255) + ',80,120)';
      g.fillRect(0, 0, 160, 120);
    }, 100);
    var stream = canvas.captureStream();
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var sender = pc1.addTrack(stream.getVideoTracks()[0], stream);
    sender.transform = sending.made;
    log('same', sender.transform === sending.made);
    try { pc1.addTransceiver('video').sender.transform = sending.made; log('reused'); }
    catch (x) { log('reuse', x.name); }
    try { sender.transform = {}; } catch (x) { log('not a transform', x.name); }
    var receiver = null;
    pc2.ontrack = function (e) { if (!receiver) { receiver = e.receiver; receiver.transform = receiving.made; } };
    await call(pc1, pc2);
    await wait('frames', function () {
      return sending.heard.some(function (h) { return /^detached/.test(h); }) &&
        receiving.heard.some(function (h) { return /^detached/.test(h); });
    });
    log('heard', sending.heard.concat(receiving.heard).sort().join(','));
    // what the receiver's transform wrote back decodes: the bytes it
    // inverted were inverted back
    var decoded = 0;
    for (var end = Date.now() + 15000; decoded <= 2 && Date.now() < end; ) {
      (await pc2.getStats()).forEach(function (x) { if (x.type === 'inbound-rtp') decoded = x.framesDecoded; });
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    log('decoded', decoded > 2);
    sending.port.postMessage('key');
    await wait('key', function () { return sending.heard.some(function (h) { return /^key:/.test(h); }); });
    receiving.port.postMessage('key');
    receiving.port.postMessage('pli');
    sending.port.postMessage('pli');
    await wait('answers', function () { return receiving.heard.filter(function (h) { return /^(key|pli):/.test(h); }).length === 2 && sending.heard.some(function (h) { return /^pli:/.test(h); }); });
    log('asked', sending.heard.concat(receiving.heard).filter(function (h) { return /^(key|pli):/.test(h); }).sort().join(','));
    clearInterval(timer);
    worker.terminate();
    pc1.close(); pc2.close();
    log('done');
  `);
  if (process.env.WERIFT_LOGS) console.log(logs.join('\n'));
  for (const line of [
    'same|true',
    'reuse|InvalidStateError',
    'not a transform|TypeError',
    'heard|detached:receiver:0:0,detached:sender:0:0,first:receiver:true:key:video/VP8:160x120:true:number,first:sender:true:key:video/VP8:160x120:true:number,started:receiver:true:true,started:sender:true:true',
    'decoded|true',
    'asked|key:InvalidStateError,key:number,pli:InvalidStateError,pli:ok',
    'done',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('abs-capture-time an app adds to its offer is answered and sent, and a receiver’s sources carry the capture time; offered by default it is not', async () => {
  const logs = await run(`
    ${CALL}
    var ABS = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';
    var canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    var g = canvas.getContext('2d');
    var n = 0;
    var timer = setInterval(function () { g.fillStyle = n++ % 2 ? '#fff' : '#eee'; g.fillRect(0, 0, 160, 120); }, 50);
    var ctx = new AudioContext();
    var osc = ctx.createOscillator();
    var dst = ctx.createMediaStreamDestination();
    osc.connect(dst); osc.start();
    // WPT's addHeaderExtensionToSdp
    function add(sdp) {
      var ids = sdp.split('\\n').filter(function (l) { return l.startsWith('a=extmap:'); })
        .map(function (l) { return parseInt(l.split(' ')[0].substring(9), 10); });
      var line = 'a=extmap:' + (Math.max.apply(null, ids) + 1) + ' ' + ABS + '\\r\\n';
      var sections = sdp.split('\\nm=').map(function (part, i) {
        return (i > 0 ? 'm=' + part : part).trim() + '\\r\\n';
      });
      var session = sections.shift();
      return session + sections.map(function (m) { return m + line; }).join('');
    }
    async function session(munge) {
      var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
      pc1.addTrack(canvas.captureStream().getVideoTracks()[0]);
      pc1.addTrack(dst.stream.getAudioTracks()[0]);
      pc1.onicecandidate = function (e) { pc2.addIceCandidate(e.candidate); };
      pc2.onicecandidate = function (e) { pc1.addIceCandidate(e.candidate); };
      var offer = await pc1.createOffer();
      log('offered by default', offer.sdp.indexOf(ABS) >= 0);
      if (munge) offer = { type: 'offer', sdp: add(offer.sdp) };
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      var answer = await pc2.createAnswer();
      log('answered', munge, (answer.sdp.match(new RegExp(ABS, 'g')) || []).length);
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);
      var ext = pc1.getTransceivers()[0].getNegotiatedHeaderExtensions()
        .find(function (e) { return e.uri === ABS; });
      log('negotiated', munge, ext.direction);
      return [pc1, pc2];
    }
    var on = await session(true);
    for (var r of on[1].getReceivers()) {
      var kind = r.track.kind;
      var s = await wait(kind + ' capture', function () {
        var x = r.getSynchronizationSources()[0];
        return x && x.captureTimestamp !== undefined ? x : null;
      });
      var now = performance.timeOrigin + performance.now() + 2208988800000;
      log('source', kind, s.senderCaptureTimeOffset, Math.abs(now - s.captureTimestamp) < 2000);
    }
    var off = await session(false);
    var r2 = off[1].getReceivers()[0];
    await wait('source', function () { return r2.getSynchronizationSources()[0]; });
    log('without', 'captureTimestamp' in r2.getSynchronizationSources()[0]);
    clearInterval(timer);
    on.concat(off).forEach(function (pc) { pc.close(); });
    ctx.close();
    log('done');
  `);
  if (process.env.WERIFT_LOGS) console.log(logs.join('\n'));
  for (const line of [
    'offered by default|false',
    'answered|true|2',
    'negotiated|true|sendrecv',
    'source|video|0|true',
    'source|audio|0|true',
    'answered|false|0',
    'negotiated|false|stopped',
    'without|false',
    'done',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});
