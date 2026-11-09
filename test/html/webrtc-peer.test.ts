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
import { timerClock } from '../../src/html/scripts/host.js';
import { FakeWebRTC } from '../fake-webrtc.js';
import { FRAME_MS, holdClock } from '../held-clock.js';
import type { HeldClock } from '../held-clock.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** A page's scripts, run until one logs a line starting `done`: every
 *  line it logged. Where the page's timers are held, a frame of them is
 *  taken at each look. */
async function run(
  script: string,
  scripts: HtmlScripts = { webRTC: new FakeWebRTC() },
  url = 'https://page.test/',
  timers?: HeldClock,
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
    await timers?.frame();
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
    log('config', c.bundlePolicy, c.rtcpMuxPolicy, c.iceTransportPolicy, c.iceCandidatePoolSize, c.iceServers.length, Array.isArray(c.iceServers[0].urls), c.iceServers[0].urls.join(','), c.iceServers[1].urls.join(','));
    function refused(config) {
      try { new RTCPeerConnection(config); return 'made'; } catch (e) { return e.name; }
    }
    // a URL is a scheme, a host and a port, and a TURN server's credential
    // is not empty, though its username may be
    var turn = { username: 'u', credential: 'c' };
    var urls = ['stun:', 'stun::8191', 'turn:', 'stun:example.org:131071', 'turn:2001:4860:4860::8888',
      'stun:example.org#frag', 'stun:user@example.org', 'turn:example.org/', 'stun:example.org\\\\', 'turn:example.org/path',
      'stun:example.org\\\\path', 'turn:example.org?transport=', 'turn:example.org?transport=datachannel'];
    log('urls', urls.map(function (u) { return refused({ iceServers: [Object.assign({ urls: u }, turn)] }); }).join(','));
    log('hosts', ['stun:[::1]:3478', 'stun:stun.l.google.com:19302', 'turns:turn.example.org?transport=tcp'].map(function (u) {
      return refused({ iceServers: [Object.assign({ urls: u }, turn)] });
    }).join(','));
    log('credentials',
      refused({ iceServers: [{ urls: 'turn:turn.example.net', username: 'u', credential: '' }] }),
      refused({ iceServers: [{ urls: 'turn:turn.example.net', username: '', credential: 'c' }] }));
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
      'config|balanced|require|all|0|2|true|stun:stun.example.net|turn:turn.example.net?transport=udp',
    ),
    logs.join('\n'),
  );
  assert.ok(
    logs.includes(
      'urls|SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError',
    ),
    logs.join('\n'),
  );
  assert.ok(logs.includes('hosts|made,made,made'), logs.join('\n'));
  assert.ok(
    logs.includes('credentials|InvalidAccessError|made'),
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
  // The flag is updated in a task the facade queues at 0 ms
  // (`updateNegotiationNeeded`), so a `wait(0)` after a change runs after
  // that change's update: Node runs timers of one duration in the order they
  // were queued. That is how a step says nothing more was fired. A step that
  // expects an event waits for it, because a 10 ms wait is no bound on a 0 ms
  // task: a loop that wakes late runs every due timer in the 10 ms list
  // before it gets to the 1 ms one, and a 10 ms timer queued after the task
  // can run first.
  const logs = await run(`
    ${NEGOTIATE}
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var count = 0;
    pc1.onnegotiationneeded = function () { count++; };
    var t = pc1.addTransceiver('audio');
    pc1.addTransceiver('video');
    await until(function () { return count > 0; });
    await wait(0);
    log('added', count);
    await negotiate(pc1, pc2);
    await wait(0);
    log('negotiated', count);
    t.direction = 'recvonly';
    await until(function () { return count > 1; });
    log('direction', count);
    await negotiate(pc1, pc2);
    t.direction = 'recvonly';
    await wait(0);
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

test('a flag raised before an answer and still raised after it is told again, once the connection is stable', async () => {
  const logs = await run(`
    ${NEGOTIATE}
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.addTransceiver('audio');
    await new Promise(function (r) { a.onnegotiationneeded = r; });
    await a.setLocalDescription();
    var fired = 0;
    a.onnegotiationneeded = function () { fired++; };
    a.createDataChannel('test');
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription);
    await undefined;
    var early = fired;
    await until(function () { return fired > 0; });
    await wait(20);
    log('again', early, fired, a.signalingState);
    // and an answer that leaves nothing to negotiate tells nothing
    var c = new RTCPeerConnection(), d = new RTCPeerConnection();
    c.addTransceiver('audio');
    await new Promise(function (r) { c.onnegotiationneeded = r; });
    var more = 0;
    c.onnegotiationneeded = function () { more++; };
    await negotiate(c, d);
    await wait(20);
    log('done', more);
    a.close(); b.close(); c.close(); d.close();
  `);
  for (const line of ['again|0|1|stable', 'done|0']) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('restartIce asks for negotiation only where a local description has credentials to replace', async () => {
  const logs = await run(`
    ${NEGOTIATE}
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    var count = 0;
    a.onnegotiationneeded = function () { count++; };
    a.restartIce();
    await wait(20);
    log('before any', count);
    a.addTransceiver('audio');
    await until(function () { return count === 1; });
    a.restartIce();
    await wait(20);
    log('before the first offer', count);
    await negotiate(a, b);
    await wait(20);
    var settled = count;
    a.restartIce();
    await until(function () { return count > settled; });
    log('after', count - settled);
    a.close(); b.close();
  `);
  for (const line of ['before any|0', 'before the first offer|1', 'after|1']) {
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
      // the ufrag is the dictionary's alone, whatever the string names
      'fields|1|rtp|udp|2122260223|192.0.2.1|40000|host||{"candidate":"candidate:1 1 udp 2122260223 192.0.2.1 40000 typ host ufrag abcd","sdpMid":"0","sdpMLineIndex":null,"usernameFragment":null}',
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

test('a rollback takes away the SCTP transport the rolled-back description made, and keeps one already negotiated', async () => {
  const logs = await run(`
    ${NEGOTIATE}
    var pc = new RTCPeerConnection();
    pc.createDataChannel('test');
    var offer = await pc.createOffer();
    log('ahead', pc.sctp === null);
    await pc.setLocalDescription(offer);
    log('offered', pc.sctp instanceof RTCSctpTransport);
    await pc.setLocalDescription({ type: 'rollback' });
    log('local rollback', pc.sctp === null);
    await pc.setLocalDescription(offer);
    log('again', pc.sctp instanceof RTCSctpTransport, pc.sctp.maxChannels, typeof pc.sctp.maxMessageSize);
    var remote = new RTCPeerConnection();
    await remote.setRemoteDescription(offer);
    log('remote offer', remote.sctp instanceof RTCSctpTransport);
    await remote.setRemoteDescription({ type: 'rollback' });
    log('remote rollback', remote.sctp === null);
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.createDataChannel('x');
    await negotiate(a, b);
    var kept = a.sctp;
    await a.setLocalDescription(await a.createOffer());
    await a.setLocalDescription({ type: 'rollback' });
    log('negotiated', a.sctp === kept && kept !== null);
    pc.close(); remote.close(); a.close(); b.close();
  `);
  for (const line of [
    'ahead|true',
    'offered|true',
    'local rollback|true',
    'again|true||number',
    'remote offer|true',
    'remote rollback|true',
    'negotiated|true',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
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
    'devices|audioinput true,videoinput true,audiooutput true',
    'stopped|ended,ended',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('a candidate’s fields are RFC 8839’s grammar, all null where any is not, and its ufrag is the dictionary’s', async () => {
  const logs = await run(`
    function fields(text) {
      var c = new RTCIceCandidate({ candidate: text, sdpMid: '0' });
      return [c.foundation, c.component, c.protocol, c.priority, c.address, c.port, c.type, c.tcpType, c.relatedAddress, c.relatedPort].join(' ');
    }
    log('host', fields('candidate:1905690388 1 udp 2113937151 192.168.0.1 58041 typ host generation 0 ufrag thC8 network-cost 50'));
    log('tcp', fields('candidate:435653019 2 TCP 1845501695 192.168.0.196 4444 typ SRFLX raddr www.example.com rport 22222 tcptype ACTIVE'));
    log('framed', fields('a=candidate:1 1 udp 100 1.2.3.4 5678 typ host'));
    var bad = [
      'candidate:1 0 udp 100 1.2.3.4 5678 typ host',
      'candidate:1 257 udp 100 1.2.3.4 5678 typ host',
      'candidate:1 1 udp 0 1.2.3.4 5678 typ host',
      'candidate:1 1 udp 2147483648 1.2.3.4 5678 typ host',
      'candidate:' + 'a'.repeat(33) + ' 1 udp 100 1.2.3.4 5678 typ host',
      'candidate:foo-bar 1 udp 100 1.2.3.4 5678 typ host',
      'candidate:1 1 udp 100 1.2.3.4 5678 typ srflx',
      'candidate:1 1 udp 100 1.2.3.4 5678 typ srflx raddr 5.6.7.8',
      'candidate:1 1 udp 100 1.2.3.4 5678 typ srflx raddr 5.6.7.8 rport 9012abc',
      'candidate:1 1 tcp 100 1.2.3.4 5678 typ host',
      'candidate:1 1 tcp 100 1.2.3.4 5678 typ host tcptype',
      'candidate:1 1 tcp 100 1.2.3.4 5678 typ host generation 0 tcptype active',
      'candidate:1 1 dccp 100 1.2.3.4 5678 typ host',
      ' candidate:1 1 udp 100 1.2.3.4 5678 typ host',
      'candidate: 1 1 udp 100 1.2.3.4 5678 typ host',
    ];
    log('bad', bad.filter(function (b) { return fields(b) !== '         '; }).join(';'));
    var c = new RTCIceCandidate({ candidate: 'candidate:1 1 udp 100 1.2.3.4 5678 typ host ufrag thC8', sdpMid: '0' });
    log('ufrag', c.usernameFragment);
    log('null', new RTCIceCandidate({ candidate: null, sdpMLineIndex: 65537 }).candidate, new RTCIceCandidate({ sdpMLineIndex: 65537 }).sdpMLineIndex);
    var local = new RTCIceCandidate({ sdpMid: '0', relayProtocol: 'tls', url: 'turn:turn.example.net' });
    var copy = new RTCIceCandidate(local), signaled = new RTCIceCandidate(JSON.parse(JSON.stringify(local)));
    log('relay', local.relayProtocol, local.url, copy.relayProtocol, copy.url, signaled.relayProtocol, signaled.url);
    try { new RTCIceCandidate({ sdpMid: '0', relayProtocol: 'quic' }); } catch (e) { log('relayProtocol', e.name); }
    function threw(f) { try { f(); return 'made'; } catch (e) { return e.name; } }
    log('ice event',
      threw(function () { new RTCPeerConnectionIceEvent(); }),
      threw(function () { new RTCPeerConnectionIceEvent('icecandidate', { candidate: { candidate: '', sdpMid: '0' } }); }),
      threw(function () { new RTCPeerConnectionIceEvent('icecandidate', { candidate: local }); }),
      new RTCPeerConnectionIceEvent('icecandidate').candidate);
    log('capabilities', RTCRtpSender.getCapabilities('dummy'), RTCRtpReceiver.getCapabilities('dummy'));
    var expiry = await Promise.all([-1, 'invalid'].map(function (expires) {
      return RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256', expires: expires })
        .then(function () { return 'made'; }, function (e) { return e.name; });
    }));
    log('expires', expiry.join(','));
  `);
  for (const line of [
    'host|1905690388 rtp udp 2113937151 192.168.0.1 58041 host   ',
    'tcp|435653019 rtcp tcp 1845501695 192.168.0.196 4444 srflx active www.example.com 22222',
    'framed|1 rtp udp 100 1.2.3.4 5678 host   ',
    'bad|',
    'ufrag|',
    'null|null|1',
    'relay|tls|turn:turn.example.net|tls|turn:turn.example.net||',
    'relayProtocol|TypeError',
    'ice event|TypeError|TypeError|made|',
    'capabilities||',
    'expires|TypeError,TypeError',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('the API converts and times what WebRTC 1.0 says: a channel’s label, stopped, a sender’s encodings, its transport and replaceTrack', async () => {
  const logs = await run(
    `
    ${NEGOTIATE}
    var pc = new RTCPeerConnection();
    log('createDataChannel', pc.createDataChannel.length, pc.createDataChannel(undefined).label,
      pc.createDataChannel('\\uD800', { protocol: '\\uD800' }).label === '\\uFFFD');
    try { pc.createDataChannel(); } catch (e) { log('no label', e.name); }
    var encodings = [];
    for (var i = 0; i < 1000; i++) encodings.push({ rid: 'r' + i });
    var v = pc.addTransceiver('video', { sendEncodings: encodings });
    var scales = v.sender.getParameters().encodings.map(function (e) { return e.scaleResolutionDownBy; });
    log('encodings', scales.length, scales.join(','));
    var t = pc.addTransceiver('audio');
    log('stopped', t.stopped);
    t.stop();
    log('stopping', t.stopped);
    pc.close();
    // a remote offer sets no transport; the answer that follows does
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.addTransceiver('audio');
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    var u = b.getTransceivers()[0];
    log('remote offer', u.sender.transport, u.receiver.transport);
    await b.setLocalDescription();
    log('answer', !!u.sender.transport, u.sender.transport === u.receiver.transport);
    a.close(); b.close();
    // replaceTrack sets the track in a task of its own
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var other = (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks()[0];
    var c = new RTCPeerConnection();
    var sender = c.addTrack(stream.getTracks()[0], stream);
    var p = sender.replaceTrack(other);
    var now = sender.track === other;
    c.removeTrack(sender);
    await p;
    log('replaceTrack', now, sender.track === other);
    c.close();
  `,
    { webRTC: new FakeWebRTC(), mediaDevices: fakeMediaDevices() },
  );
  for (const line of [
    'createDataChannel|1|undefined|true',
    'no label|TypeError',
    'encodings|4|8,4,2,1',
    'stopped|false',
    'stopping|false',
    'remote offer||',
    'answer|true|true',
    'replaceTrack|false|true',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('a remote track’s streams are its msid’s, a source’s where the section has none, and the default one where nothing names one', async () => {
  const logs = await run(`
    var base = 'v=0\\r\\no=- 1 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\na=msid-semantic:WMS *\\r\\n' +
      'm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\nc=IN IP4 0.0.0.0\\r\\na=ice-ufrag:someufrag\\r\\n' +
      'a=ice-pwd:somelongpwdwithenoughrandomness\\r\\na=fingerprint:sha-256 ' + new Array(33).join('00:').slice(0, -1) + '\\r\\n' +
      'a=setup:actpass\\r\\na=mid:0\\r\\na=sendrecv\\r\\na=rtcp-mux\\r\\na=rtpmap:111 opus/48000/2\\r\\n';
    async function streams(extra) {
      var pc = new RTCPeerConnection();
      var heard = new Promise(function (r) { pc.ontrack = r; });
      await pc.setRemoteDescription({ type: 'offer', sdp: base + extra });
      var e = await heard;
      pc.close();
      return e.streams.map(function (s) { return s.id; }).join('+') || 'none';
    }
    log('none', await streams(''));
    log('source', await streams('a=ssrc:3 cname:4\\r\\na=ssrc:3 msid:1 2\\r\\n'));
    log('media first', await streams('a=msid:1 2\\r\\na=ssrc:3 cname:4\\r\\na=ssrc:3 msid:3 2\\r\\n'));
    log('dash', await streams('a=msid:-\\r\\n'));
    log('twice', await streams('a=msid:1 2\\r\\na=msid:1 2\\r\\n'));
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.addTransceiver('audio');
    var other = new Promise(function (r) { b.ontrack = r; });
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    log('no stream', (await other).streams.length);
    a.close(); b.close();
  `);
  for (const line of [
    'none|default',
    'source|1',
    'media first|1',
    'dash|none',
    'twice|1',
    'no stream|0',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('streams a sender is given anew reach the far side as a second track event, of the same track', async () => {
  const logs = await run(`
    ${NEGOTIATE}
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    var heard = [];
    b.ontrack = function (e) { heard.push(e); };
    var t = a.addTransceiver('audio', { direction: 'sendrecv' });
    await negotiate(a, b);
    var s1 = new MediaStream(), s2 = new MediaStream();
    t.sender.setStreams(s1, s2);
    await negotiate(a, b);
    var last = heard[heard.length - 1];
    log('events', heard.length, heard[0].streams.length, last.streams.map(function (s) { return s.id === s1.id || s.id === s2.id; }).join(','),
      last.track === heard[0].track, last.streams[0].getTracks()[0] === last.track);
    a.close(); b.close();
  `);
  assert.ok(logs.includes('events|2|0|true,true|true|true'), logs.join('\n'));
});

test('a certificate clones with its expiry, fingerprints and origin, and a worker cannot take one', async () => {
  const logs = await run(`
    var cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    var copy = structuredClone(cert);
    log('copy', copy instanceof RTCCertificate, copy !== cert, copy.expires === cert.expires, copy.getFingerprints()[0].value);
    var pc = new RTCPeerConnection({ certificates: [copy] });
    log('same origin', pc.getConfiguration().certificates.length);
    pc.close();
    var src = 'onmessage = function () { postMessage("message"); };' +
      'onmessageerror = function () { postMessage("messageerror"); };';
    var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    var heard = new Promise(function (ok) { w.onmessage = function (e) { ok(e.data); }; });
    w.postMessage(cert);
    log('worker', await heard);
    w.terminate();
  `);
  for (const line of [
    'copy|true|true|true|ab:cd:ef',
    'same origin|1',
    'worker|messageerror',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('an audio sender’s DTMF sender plays its tones in turn once connected, each told as it starts and the seam handed it', async (t) => {
  // the page's timers are held, and the seam stamps each tone with their
  // time
  const timers = holdClock(t, timerClock);
  const webRTC = new FakeWebRTC({ now: () => timers.time });
  const logs = await run(
    `
    ${NEGOTIATE}
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var sender = pc1.addTrack(stream.getTracks()[0], stream);
    var video = pc1.addTransceiver('video').sender;
    var dtmf = sender.dtmf;
    log('made', dtmf instanceof RTCDTMFSender, dtmf === sender.dtmf, video.dtmf, dtmf.canInsertDTMF, dtmf.toneBuffer === '');
    try { new RTCDTMFSender(); } catch (e) { log('constructor', e.name); }
    try { dtmf.insertDTMF(''); } catch (e) { log('unconnected', e.name); }
    await negotiate(pc1, pc2);
    await until(function () { return dtmf.canInsertDTMF; });
    log('connected', pc1.connectionState, dtmf.canInsertDTMF);
    try { dtmf.insertDTMF('12E'); } catch (e) { log('unrecognized', e.name, dtmf.toneBuffer === ''); }
    dtmf.insertDTMF('ab#*');
    log('buffer', dtmf.toneBuffer);
    var heard = [];
    dtmf.ontonechange = function (e) {
      heard.push(e.tone === '' ? '-' : e.tone);
    };
    // a later call replaces the buffer and the times; the one queued task
    // plays it
    dtmf.insertDTMF('12', 10, 10);
    log('replaced', dtmf.toneBuffer);
    await until(function () { return heard.length === 3; });
    log('tones', heard.join(','), dtmf.toneBuffer === '');
    // a stopped transceiver plays no more
    heard = [];
    dtmf.addEventListener('tonechange', function (e) {
      if (e.tone === '4') pc1.getTransceivers()[0].stop();
    });
    dtmf.insertDTMF('345', 40, 30);
    await wait(400);
    log('stopped', heard.join(','), dtmf.canInsertDTMF);
    try { dtmf.insertDTMF('6'); } catch (e) { log('after stop', e.name); }
    pc1.close(); pc2.close();
  `,
    { webRTC, mediaDevices: fakeMediaDevices() },
    undefined,
    timers,
  );
  for (const line of [
    'made|true|true||false|true',
    'constructor|TypeError',
    'unconnected|InvalidStateError',
    'connected|connected|true',
    'unrecognized|InvalidCharacterError|true',
    'buffer|AB#*',
    'replaced|12',
    'tones|1,2,-|true',
    'stopped|3,4|false',
    'after stop|InvalidStateError',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
  // the seam was handed each tone at the clamped duration, and no ','
  const sent = webRTC.connections[0]!.transceivers[0]!;
  assert.deepEqual(sent.tones, ['1:40', '2:40', '3:40', '4:40']);
  // and each tone the clamped 40 and 30 after the one before, where 10 and
  // 10 were asked for. Timed on the page's timers, held: a timer is due at
  // the first frame at or past its time, so a gap is 70 to a frame more
  // whatever the runner is doing. On the wall clock it was not: Node arms a
  // timer from the loop's time, read once an iteration, so one armed late in
  // a busy iteration came due early, and 70 read 68.997.
  const at = sent.toneTimes;
  for (const [from, to] of [
    [0, 1],
    [2, 3],
  ] as const) {
    const gap = at[to]! - at[from]!;
    assert.ok(
      gap >= 70 && gap < 70 + FRAME_MS,
      `tone ${to + 1} came ${gap} ms after tone ${from + 1}`,
    );
  }
});

test('a channel queues 16 MiB at most, and the page’s own close announces no closing', async () => {
  const logs = await run(`
    ${NEGOTIATE}
    var pc = new RTCPeerConnection();
    var dc = pc.createDataChannel('x', { negotiated: true, id: 3 });
    log('made', dc.readyState, dc.id);
    await until(function () { return dc.readyState === 'open'; });
    var events = [];
    ['closing', 'close', 'error'].forEach(function (type) {
      dc.addEventListener(type, function () { events.push(type); });
    });
    var chunk = new Uint8Array(64 * 1024), sent = 0, refused = null;
    try {
      while (sent < 20 * 1024 * 1024) { dc.send(chunk); sent += chunk.length; }
    } catch (e) {
      refused = e.name + ' ' + (e instanceof DOMException);
    }
    log('sent', sent / 1024 / 1024, refused, dc.bufferedAmount / 1024 / 1024);
    dc.close();
    log('closing', dc.readyState);
    await until(function () { return dc.readyState === 'closed'; });
    log('closed', events.join(','));
    pc.close();
  `);
  for (const line of [
    'made|connecting|3',
    'sent|16|OperationError true|16',
    'closing|closing',
    'closed|close',
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

test('an AudioContext’s oscillator into a stream destination is an audio track, on an insecure page too, which a peer sends', async () => {
  const logs = await run(
    `
    var ctx = new AudioContext();
    log('context', ctx.state, ctx.sampleRate, ctx.destination instanceof AudioDestinationNode, ctx.destination.maxChannelCount, ctx.baseLatency > 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    var dst = osc.connect(gain).connect(ctx.createMediaStreamDestination());
    osc.start();
    var track = dst.stream.getAudioTracks()[0];
    log('track', dst instanceof MediaStreamAudioDestinationNode, track.kind, track.readyState, track.muted, dst.stream instanceof MediaStream);
    log('params', osc.frequency.value, osc.frequency.defaultValue, osc.type, gain.gain.value, osc.frequency.setValueAtTime(220, 0) === osc.frequency);
    function refused(f) { try { f(); return 'made'; } catch (e) { return e.name; } }
    log('refused', refused(function () { osc.start(); }), refused(function () { osc.type = 'custom'; }), refused(function () { osc.connect(dst, 1); }),
      refused(function () { new AudioContext({ sampleRate: 1 }); }), refused(function () { new AudioNode(); }), refused(function () { gain.gain.exponentialRampToValueAtTime(0, 1); }));
    await new Promise(function (r) { ctx.onstatechange = r; });
    log('running', ctx.state);
    var t0 = ctx.currentTime;
    await new Promise(function (r) { setTimeout(r, 50); });
    log('clock', ctx.currentTime > t0, (ctx.currentTime * ctx.sampleRate) % 128);
    var ended = new Promise(function (r) { osc.onended = r; });
    osc.stop(ctx.currentTime + 0.02);
    await ended;
    log('ended', true);
    try { await ctx.decodeAudioData(new ArrayBuffer(8)); } catch (e) { log('decode', e.name, e instanceof DOMException); }
    var buffer = ctx.createBuffer(2, 4800, 48000);
    log('buffer', buffer.duration, buffer.numberOfChannels, buffer.getChannelData(1).length);
    var pc = new RTCPeerConnection();
    pc.addTrack(track, dst.stream);
    await pc.setLocalDescription();
    log('sent', /m=audio/.test(pc.localDescription.sdp));
    await ctx.close();
    log('closed', ctx.state);
    pc.close();
  `,
    { webRTC: new FakeWebRTC() },
    'http://page.test/',
  );
  for (const line of [
    'context|suspended|48000|true|2|true',
    'track|true|audio|live|false|true',
    'params|440|440|sine|1|true',
    'refused|InvalidStateError|InvalidStateError|IndexSizeError|NotSupportedError|TypeError|RangeError',
    'running|running',
    'clock|true|0',
    'ended|true',
    'decode|EncodingError|true',
    'buffer|0.1|2|4800',
    'sent|true',
    'closed|closed',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('decodeAudioData reads a WAV file at the context rate, and says it cannot read anything else', async () => {
  // jspaint puts up a dialog for each sound that does not decode
  const logs = await run(`
    function wav(bits, format, rate, samples) {
      var width = bits >> 3;
      var data = new ArrayBuffer(44 + samples.length * width);
      var v = new DataView(data);
      function tag(at, text) {
        for (var i = 0; i < 4; i++) v.setUint8(at + i, text.charCodeAt(i));
      }
      tag(0, 'RIFF');
      v.setUint32(4, 36 + samples.length * width, true);
      tag(8, 'WAVE');
      tag(12, 'fmt ');
      v.setUint32(16, 16, true);
      v.setUint16(20, format, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, rate, true);
      v.setUint16(34, bits, true);
      tag(36, 'data');
      v.setUint32(40, samples.length * width, true);
      samples.forEach(function (s, i) {
        if (bits === 16) v.setInt16(44 + i * 2, s, true);
        else v.setFloat32(44 + i * 4, s, true);
      });
      return data;
    }
    var ctx = new AudioContext({ sampleRate: 8000 });
    var pcm = await ctx.decodeAudioData(wav(16, 1, 8000, [16384, -16384]));
    log('pcm', pcm.length, pcm.sampleRate, Array.from(pcm.getChannelData(0)).join());
    var float = await ctx.decodeAudioData(wav(32, 3, 8000, [0.25]));
    log('float', float.getChannelData(0)[0]);
    var slower = await ctx.decodeAudioData(wav(16, 1, 4000, [0, 16384, 0]));
    log('slower', slower.length, Array.from(slower.getChannelData(0)).join());
    var heard = 0;
    await ctx.decodeAudioData(wav(16, 1, 8000, [0]), function (b) { heard = b.length; });
    log('callback', heard);
    await ctx.decodeAudioData(new ArrayBuffer(64)).catch(function (e) { log('refused', e.name); });
    await ctx.close();
  `);
  for (const line of [
    'pcm|2|8000|0.5,-0.5',
    'float|0.25',
    'slower|6|0,0.25,0.5,0.25,0,0',
    'callback|1',
    'refused|EncodingError',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('a remote answer narrows a sender’s encodings to the rids its a=simulcast receives, and one with none to the first', async () => {
  const logs = await run(`
    function rids(sender) {
      return sender.getParameters().encodings.map(function (e) { return e.rid + ':' + e.scaleResolutionDownBy; }).join(',');
    }
    async function answered(simulcast) {
      var a = new RTCPeerConnection(), b = new RTCPeerConnection();
      var t = a.addTransceiver('video', { sendEncodings: [{ rid: 'foo' }, { rid: 'bar' }] });
      await a.setLocalDescription();
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription();
      var sdp = b.localDescription.sdp.replace(/(a=mid:[^\\r\\n]*\\r\\n)/, '$1' + (simulcast ? simulcast + '\\r\\n' : ''));
      await a.setRemoteDescription({ type: 'answer', sdp: sdp });
      var out = rids(t.sender);
      a.close(); b.close();
      return out;
    }
    log('offered', rids(new RTCPeerConnection().addTransceiver('video', { sendEncodings: [{ rid: 'foo' }, { rid: 'bar' }] }).sender));
    log('to foo', await answered('a=simulcast:recv foo'));
    log('to bar', await answered('a=simulcast:recv ~baz;bar,foo'));
    log('to none', await answered(''));
  `);
  for (const line of [
    'offered|foo:2,bar:1',
    'to foo|foo:2',
    'to bar|bar:1',
    'to none|undefined:2',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});

test('media a stack carries: a sender reads its track beside the page, and a remote track unmutes, plays in a <video>, names its sources and its stats', async () => {
  const logs = await run(
    `
    ${NEGOTIATE}
    function wait(test) {
      return new Promise(function (resolve, reject) {
        var end = Date.now() + 5000;
        (function look() {
          var got = test();
          if (got) return resolve(got);
          if (Date.now() > end) return reject(new Error('timed out: ' + test));
          setTimeout(look, 10);
        })();
      });
    }
    var canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 48;
    var g = canvas.getContext('2d');
    var n = 0;
    var timer = setInterval(function () { g.fillStyle = 'rgb(' + (n++ * 10 % 255) + ',0,0)'; g.fillRect(0, 0, 64, 48); }, 20);
    var stream = canvas.captureStream();
    var track = stream.getVideoTracks()[0];
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = function (e) { b.addIceCandidate(e.candidate); };
    b.onicecandidate = function (e) { a.addIceCandidate(e.candidate); };
    a.addTrack(track, stream);
    var remote = null, events = [];
    var video = document.createElement('video');
    var metadata = new Promise(function (r) { video.onloadedmetadata = r; });
    b.ontrack = function (e) {
      remote = e.track;
      events.push('track:' + e.track.muted);
      e.track.onunmute = function () { events.push('unmute'); };
      e.track.onmute = function () { events.push('mute'); };
      video.srcObject = e.streams[0];
    };
    await negotiate(a, b);
    await wait(function () { return remote && !remote.muted; });
    log('local', track.readyState, track.muted);
    await metadata;
    log('metadata', video.videoWidth, video.videoHeight);
    var r = b.getReceivers()[0];
    var s = r.getSynchronizationSources()[0];
    log('sources', s.source, typeof s.timestamp, r.getContributingSources().length);
    var inbound = [...(await b.getStats()).values()].find(function (x) { return x.type === 'inbound-rtp'; });
    log('inbound', inbound.trackIdentifier === remote.id, inbound.mid);
    var selected = await b.getStats(remote);
    log('selected', [...selected.values()].filter(function (x) { return x.type === 'inbound-rtp'; }).length);
    var sender = a.getSenders()[0];
    log('sent', [...(await sender.getStats()).values()].filter(function (x) { return x.type === 'outbound-rtp'; }).length);
    a.close();
    await wait(function () { return remote.muted; });
    log('events', events.join(','));
    var closed = await a.getStats();
    log('closed', closed instanceof RTCStatsReport,
      [...(await sender.getStats()).values()].length);
    clearInterval(timer);
    track.stop();
    b.close();
  `,
    { webRTC: new FakeWebRTC({ media: true }) },
  );
  for (const line of [
    'local|live|false',
    'metadata|64|48',
    'sources|1234|number|0',
    'inbound|true|0',
    'selected|1',
    'sent|1',
    'events|track:true,unmute,mute',
    'closed|true|0',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});
