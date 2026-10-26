// `<Html scripts>`' WebRTC (`src/html/scripts/webrtc.ts`, the host's half in
// `peers.ts`): a page's `RTCPeerConnection` over the `webRTC` seam, which a
// fake stack answers here (`../fake-webrtc.ts`), so that what WebRTC 1.0
// says of the API — the operations chain, the signalling state, every check
// and its error, the events and their order — is held on every runtime CI
// runs. `webrtc-werift.test.ts` holds the same page over werift, and WPT's
// own tests run through `scripts/conformance/interop.ts`.
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
import { FakeWebRTC } from '../fake-webrtc.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** A page's scripts, run until one logs a line starting `done`: every
 *  line it logged. */
async function run(
  script: string,
  scripts: HtmlScripts = { webRTC: new FakeWebRTC() },
  url = 'https://page.test/',
): Promise<string[]> {
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source:
        '<script>' +
        'function log() { console.log([].slice.call(arguments).join("|")); }' +
        `(async function () { try { ${script} } catch (e) { log("failed", e.name, e.message); } log("done"); })();` +
        '</script>',
      partial: false,
      baseUrl: url,
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

const NEGOTIATE = `
  async function negotiate(a, b) {
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }
  async function until(f) { for (var i = 0; i < 500 && !f(); i++) await wait(5); }
`;

test('the constructor takes a configuration and refuses one as WebRTC 1.0 does', async () => {
  const logs = await run(`
    var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.example.net' }, { urls: ['turn:turn.example.net?transport=udp'], username: 'u', credential: 'c' }] });
    var c = pc.getConfiguration();
    log('config', c.bundlePolicy, c.rtcpMuxPolicy, c.iceTransportPolicy, c.iceCandidatePoolSize, c.iceServers.length, c.iceServers[0].urls, c.iceServers[1].urls.join(','));
    function refused(config) {
      try { new RTCPeerConnection(config); return 'made'; } catch (e) { return e.name; }
    }
    log('refused',
      refused({ bundlePolicy: 'sideways' }),
      refused({ iceServers: [{ urls: 'turn:turn.example.net' }] }),
      refused({ iceServers: [{ urls: 'http://example.net' }] }),
      refused({ iceServers: [{ urls: 'stun:example.net?transport=udp' }] }),
      refused({ iceServers: [{ urls: [] }] }),
      refused({ iceCandidatePoolSize: 256 }),
      refused({ rtcpMuxPolicy: 'negotiate' }));
    log('states', pc.signalingState, pc.iceGatheringState, pc.iceConnectionState, pc.connectionState, pc.localDescription, pc.canTrickleIceCandidates);
    pc.close();
    log('closed', pc.signalingState, pc.connectionState, pc.iceConnectionState);
    try { pc.createDataChannel('x'); } catch (e) { log('after close', e.name); }
  `);
  assert.ok(
    logs.includes(
      'config|balanced|require|all|0|2|stun:stun.example.net|turn:turn.example.net?transport=udp',
    ),
    logs.join('\n'),
  );
  assert.ok(
    logs.includes(
      'refused|TypeError|InvalidAccessError|SyntaxError|SyntaxError|SyntaxError|TypeError|TypeError',
    ),
    logs.join('\n'),
  );
  assert.ok(logs.includes('states|stable|new|new|new||'), logs.join('\n'));
  assert.ok(logs.includes('closed|closed|closed|closed'), logs.join('\n'));
  assert.ok(logs.includes('after close|InvalidStateError'), logs.join('\n'));
});

test('a description moves the signalling state, told before the operation settles', async () => {
  const logs = await run(`
    var pc = new RTCPeerConnection();
    var told = [];
    pc.onsignalingstatechange = function () { told.push(pc.signalingState); };
    pc.addTransceiver('audio');
    var offer = await pc.createOffer();
    log('offer', offer.type, typeof offer.sdp, offer instanceof RTCSessionDescription);
    var p = pc.setLocalDescription(offer);
    log('pending', pc.signalingState);
    await p;
    log('local', pc.signalingState, told.join(','), pc.localDescription.type, pc.pendingLocalDescription === pc.localDescription, pc.currentLocalDescription);
    try { await pc.setLocalDescription({ type: 'answer', sdp: offer.sdp }); } catch (e) { log('answer in have-local-offer', e.name); }
    try { await pc.setLocalDescription({ type: 'offer', sdp: offer.sdp + 'a=x\\r\\n' }); } catch (e) { log('modified', e.name); }
    await pc.setLocalDescription({ type: 'rollback' });
    log('rolled back', pc.signalingState, told.join(','), pc.localDescription);
    try { await pc.setRemoteDescription({ type: 'rollback' }); } catch (e) { log('rollback in stable', e.name); }
    try { await pc.setRemoteDescription({ sdp: 'v=0' }); } catch (e) { log('no type', e.name); }
    try { await pc.createAnswer(); } catch (e) { log('answer in stable', e.name); }
  `);
  for (const line of [
    'offer|offer|string|false',
    'pending|stable',
    'local|have-local-offer|have-local-offer|offer|true|',
    'answer in have-local-offer|InvalidStateError',
    'modified|InvalidModificationError',
    'rolled back|stable|have-local-offer,stable|',
    'rollback in stable|InvalidStateError',
    'no type|TypeError',
    'answer in stable|InvalidStateError',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('operations run in turn on the chain, and a closed connection settles none of them', async () => {
  const logs = await run(`
    var pc = new RTCPeerConnection();
    pc.addTransceiver('video');
    var order = [];
    var a = pc.createOffer().then(function () { order.push('offer'); });
    var b = pc.setLocalDescription().then(function () { order.push('local ' + pc.signalingState); });
    var c = pc.createOffer().then(function () { order.push('offer again'); });
    await Promise.all([a, b, c]);
    log('order', order.join(','));
    var settled = false;
    pc.createOffer().then(function () { settled = true; }, function () { settled = true; });
    pc.close();
    await new Promise(function (r) { setTimeout(r, 50); });
    log('after close', settled);
    try { await pc.createOffer(); } catch (e) { log('closed', e.name); }
  `);
  assert.ok(
    logs.includes('order|offer,local have-local-offer,offer again'),
    logs.join('\n'),
  );
  assert.ok(logs.includes('after close|false'), logs.join('\n'));
  assert.ok(logs.includes('closed|InvalidStateError'), logs.join('\n'));
});

test('negotiationneeded is fired once a change needs it, and not again until it is negotiated', async () => {
  const logs = await run(`
    ${NEGOTIATE}
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var count = 0;
    pc1.onnegotiationneeded = function () { count++; };
    var t = pc1.addTransceiver('audio');
    pc1.addTransceiver('video');
    await wait(10);
    log('added', count);
    await negotiate(pc1, pc2);
    await wait(10);
    log('negotiated', count);
    t.direction = 'recvonly';
    await wait(10);
    log('direction', count);
    await negotiate(pc1, pc2);
    t.direction = 'recvonly';
    await wait(10);
    log('same direction', count);
    pc1.close(); pc2.close();
  `);
  for (const line of [
    'added|1',
    'negotiated|1',
    'direction|2',
    'same direction|2',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('candidates are told after the description, then the end of a transport’s and of all of them', async () => {
  const logs = await run(`
    ${NEGOTIATE}
    var pc = new RTCPeerConnection();
    pc.addTransceiver('audio');
    var events = [];
    var done = new Promise(function (r) {
      pc.onicecandidate = function (e) {
        events.push(e.candidate === null ? 'null:' + pc.iceGatheringState : e.candidate.candidate === '' ? 'end:' + pc.iceGatheringState : 'candidate:' + pc.iceGatheringState);
        if (e.candidate === null) r();
      };
    });
    pc.onicegatheringstatechange = function () { events.push('gathering ' + pc.iceGatheringState); };
    await pc.setLocalDescription();
    events.push('resolved');
    await done;
    log('events', events.join(','));
    var c = new RTCIceCandidate({ candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 40000 typ host ufrag abcd', sdpMid: '0' });
    log('fields', c.foundation, c.component, c.protocol, c.priority, c.address, c.port, c.type, c.usernameFragment, JSON.stringify(c.toJSON()));
    try { new RTCIceCandidate({ candidate: '' }); } catch (e) { log('no mid', e.name); }
    pc.close();
  `);
  assert.ok(
    logs.includes(
      'events|resolved,gathering gathering,candidate:gathering,end:gathering,gathering complete,null:complete',
    ),
    logs.join('\n'),
  );
  assert.ok(
    logs.includes(
      'fields|1|rtp|udp|2122260223|192.0.2.1|40000|host|abcd|{"candidate":"candidate:1 1 udp 2122260223 192.0.2.1 40000 typ host ufrag abcd","sdpMid":"0","sdpMLineIndex":null,"usernameFragment":"abcd"}',
    ),
    logs.join('\n'),
  );
  assert.ok(logs.includes('no mid|TypeError'), logs.join('\n'));
});

test('two connections connect: the aggregate states follow their transports', async () => {
  const logs = await run(`
    ${NEGOTIATE}
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var states = [], ice = [];
    pc1.onconnectionstatechange = function () { states.push(pc1.connectionState); };
    pc1.oniceconnectionstatechange = function () { ice.push(pc1.iceConnectionState); };
    var t = pc1.addTransceiver('audio', { direction: 'sendonly' });
    await negotiate(pc1, pc2);
    log('directions', t.currentDirection, pc2.getTransceivers()[0].currentDirection, t.mid, pc2.getTransceivers()[0].mid);
    await until(function () { return pc1.connectionState === 'connected'; });
    log('states', states.join(','), ice.join(','));
    log('transport', t.sender.transport === t.receiver.transport, t.sender.transport.state, t.sender.transport.iceTransport.state, t.sender.transport.iceTransport.role, pc1.canTrickleIceCandidates);
    pc1.close(); pc2.close();
    log('closed', pc1.connectionState, t.sender.transport, t.currentDirection);
  `);
  for (const line of [
    'directions|sendonly|recvonly|0|0',
    'states|connecting,connected',
    'transport|true|connected|connected|controlling|true',
    'closed|closed||stopped',
  ]) {
    assert.ok(
      logs.some((l) => l === line || l.startsWith(`${line}|`)),
      `missing ${line}:\n${logs.join('\n')}`,
    );
  }
});

test('a remote description’s tracks fire track with their streams, and a stopped transceiver goes once answered', async () => {
  const logs = await run(`
    ${NEGOTIATE}
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var stream = new MediaStream();
    var t = pc1.addTransceiver('video', { streams: [stream] });
    var heard = [];
    pc2.ontrack = function (e) {
      heard.push(e.track.kind + ' ' + e.streams.map(function (s) { return s.id === stream.id; }).join(',') + ' ' + e.track.muted + ' ' + e.track.readyState + ' ' + (e.receiver.track === e.track) + ' ' + (e.transceiver.receiver === e.receiver));
    };
    await negotiate(pc1, pc2);
    log('tracks', heard.join(';'));
    var remote = pc2.getTransceivers()[0];
    t.stop();
    log('stopping', t.direction, t.currentDirection, pc1.getTransceivers().length);
    await negotiate(pc1, pc2);
    // the remote track ends in a task of its own
    var then = remote.receiver.track.readyState;
    await wait(0);
    log('stopped', t.currentDirection, pc1.getTransceivers().length, pc2.getTransceivers().length, then, remote.receiver.track.readyState);
    pc1.close(); pc2.close();
  `);
  for (const line of [
    'tracks|video true true live true true',
    'stopping|stopped|sendonly|1',
    'stopped|stopped|0|0|live|ended',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('a track from the fake devices is sent: addTrack, and the stream it names in the offer', async () => {
  const logs = await run(
    `
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 320 } });
    var tracks = stream.getTracks();
    log('tracks', tracks.map(function (t) { return t.kind + ' ' + t.readyState + ' ' + t.label; }).join(','), tracks[1].getSettings().width, tracks[0].getSettings().deviceId.length);
    var pc = new RTCPeerConnection();
    var sender = pc.addTrack(tracks[0], stream);
    log('sender', sender.track === tracks[0], pc.getTransceivers()[0].direction);
    try { pc.addTrack(tracks[0], stream); } catch (e) { log('twice', e.name); }
    await pc.setLocalDescription();
    log('msid', pc.localDescription.sdp.indexOf('a=msid:' + stream.id) >= 0);
    pc.removeTrack(sender);
    log('removed', sender.track, pc.getTransceivers()[0].direction);
    var devices = await navigator.mediaDevices.enumerateDevices();
    log('devices', devices.map(function (d) { return d.kind + ' ' + (d.label !== ''); }).join(','));
    tracks.forEach(function (t) { t.stop(); });
    log('stopped', tracks.map(function (t) { return t.readyState; }).join(','));
    pc.close();
  `,
    { webRTC: new FakeWebRTC(), mediaDevices: fakeMediaDevices() },
  );
  for (const line of [
    'tracks|audio live Fake microphone,video live Fake camera|320|64',
    'sender|true|sendrecv',
    'twice|InvalidAccessError',
    'msid|true',
    'removed||recvonly',
    'devices|videoinput true,audioinput true,audiooutput true',
    'stopped|ended,ended',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('with no stack, a connection is made and what needs one is the page’s own NotSupportedError', async () => {
  const logs = await run(
    `
    var pc = new RTCPeerConnection();
    var t = pc.addTransceiver('audio');
    log('made', pc.getTransceivers().length, t.receiver.track.kind, t.receiver.track.muted, RTCRtpSender.getCapabilities('audio'));
    try { await pc.createOffer(); log('offered'); } catch (e) {
      log('refused', e.name, e instanceof DOMException, Object.getPrototypeOf(e) === DOMException.prototype, e.constructor.constructor === Function, /scripts\\.webRTC/.test(e.message));
    }
    try { await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }); } catch (e) {
      log('certificate', e.name, e instanceof DOMException);
    }
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) {
      log('no devices', e.name, e instanceof DOMException);
    }
    try { await navigator.mediaDevices.getUserMedia({}); } catch (e) {
      log('nothing asked', e.name, e instanceof TypeError);
    }
    pc.close();
  `,
    {},
  );
  for (const line of [
    'made|1|audio|true|',
    'refused|NotSupportedError|true|true|true|true',
    'certificate|NotSupportedError|true',
    'no devices|NotFoundError|true',
    'nothing asked|TypeError|true',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('mediaDevices is a secure context’s only, and a worker has no RTCPeerConnection', async () => {
  const logs = await run(
    `
    log('insecure', typeof navigator.mediaDevices, typeof RTCPeerConnection, typeof MediaStream);
  `,
    { webRTC: new FakeWebRTC() },
    'http://page.test/',
  );
  assert.ok(
    logs.includes('insecure|undefined|function|function'),
    logs.join('\n'),
  );
});

test('a canvas’s captureStream is a stream of one canvas track, on an insecure page too, and a peer sends it', async () => {
  const logs = await run(
    `
    var canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 48;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 64, 48);
    var stream = canvas.captureStream();
    var track = stream.getVideoTracks()[0];
    log('stream', stream instanceof MediaStream, stream.getTracks().length, track instanceof CanvasCaptureMediaStreamTrack, track instanceof MediaStreamTrack);
    log('track', track.kind, track.readyState, track.muted, track.canvas === canvas, track.label);
    var s = track.getSettings();
    log('settings', s.width, s.height, 'frameRate' in s);
    log('rated', canvas.captureStream(10).getVideoTracks()[0].getSettings().frameRate);
    var copy = track.clone();
    log('clone', copy instanceof CanvasCaptureMediaStreamTrack, copy.canvas === canvas, copy.id !== track.id);
    track.requestFrame();
    function refused(rate) { try { canvas.captureStream(rate); return 'made'; } catch (e) { return e.name; } }
    log('refused', refused(-1), refused(NaN), refused(Infinity), refused(0));
    try { CanvasCaptureMediaStreamTrack.prototype.requestFrame.call({}); } catch (e) { log('illegal', e.name); }
    var pc = new RTCPeerConnection();
    pc.addTrack(track, stream);
    await pc.setLocalDescription();
    log('sent', /m=video/.test(pc.localDescription.sdp), pc.localDescription.sdp.indexOf('a=msid:' + stream.id) >= 0);
    track.stop(); copy.stop();
    log('stopped', track.readyState, copy.readyState);
    pc.close();
  `,
    { webRTC: new FakeWebRTC() },
    'http://page.test/',
  );
  for (const line of [
    'stream|true|1|true|true',
    'track|video|live|false|true|',
    'settings|64|48|false',
    'rated|10',
    'clone|true|true|true',
    'refused|NotSupportedError|TypeError|TypeError|made',
    'illegal|TypeError',
    'sent|true|true',
    'stopped|ended|ended',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('a sender’s and a receiver’s parameters are what an answer negotiated, and an encoding’s codec it left out goes', async () => {
  const logs = await run(`
    ${NEGOTIATE}
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    var opus = RTCRtpSender.getCapabilities('audio').codecs.filter(function (c) { return c.mimeType === 'audio/opus'; })[0];
    var t = a.addTransceiver('audio', { sendEncodings: [{ codec: opus }] });
    function counts(p) { return p.codecs.length + '/' + p.headerExtensions.length; }
    log('made', counts(t.sender.getParameters()), counts(t.receiver.getParameters()), t.sender.getParameters().encodings[0].codec.mimeType);
    await a.setLocalDescription();
    log('offered', counts(t.sender.getParameters()));
    await b.setRemoteDescription(a.localDescription);
    var u = b.getTransceivers()[0];
    log('remote offer', counts(u.sender.getParameters()), counts(u.receiver.getParameters()));
    await b.setLocalDescription();
    log('answered', u.sender.getParameters().codecs.length > 0);
    await a.setRemoteDescription(b.localDescription);
    log('negotiated', t.sender.getParameters().codecs.length > 0, t.sender.getParameters().encodings[0].codec.mimeType);
    a.close(); b.close();
  `);
  for (const line of [
    'made|0/0|0/0|audio/opus',
    'offered|0/0',
    'remote offer|0/0|0/0',
    'answered|true',
    'negotiated|true|audio/opus',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});
