// The seams a page's WebRTC and media devices will be carried over
// (`src/html/rtc.ts`, `src/html/media-devices.ts`), their defaults, and the
// fake devices WPT's runner hands a page (`src/html/fake-media.ts`). The
// page's `RTCPeerConnection` and `MediaStream` are not built yet
// (docs/prd-webrtc.md); what is held here is what they will stand on.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NO_MEDIA_DEVICES,
  NO_WEBRTC,
  fakeMediaDevices,
  idleSource,
} from '../../src/html/index.js';
import type {
  MediaAudioData,
  MediaSourceLike,
  MediaVideoFrame,
  RTCConnectionEvents,
} from '../../src/html/index.js';

const NO_EVENTS: RTCConnectionEvents = {
  candidate() {},
  candidateError() {},
  transport() {},
  sctp() {},
  dataChannel() {},
};

const REQUEST = {
  origin: 'https://example.test',
  iceServers: [],
  iceTransportPolicy: 'all' as const,
  bundlePolicy: 'balanced' as const,
  rtcpMuxPolicy: 'require' as const,
  iceCandidatePoolSize: 0,
  certificates: [],
};

/** The next `count` frames a video source gives, copied, and the source
 *  stopped after them. */
function videoFrames(
  source: MediaSourceLike,
  count: number,
): Promise<MediaVideoFrame[]> {
  return new Promise((resolve) => {
    const frames: MediaVideoFrame[] = [];
    source.listen({
      video(frame) {
        if (frames.length === count) return;
        frames.push({
          ...frame,
          planes: frame.planes.map((p) =>
            p.slice(),
          ) as MediaVideoFrame['planes'],
        });
        if (frames.length === count) {
          source.stop();
          resolve(frames);
        }
      },
      muted() {},
      ended() {},
    });
  });
}

/** The next `count` chunks an audio source gives. */
function audioChunks(
  source: MediaSourceLike,
  count: number,
): Promise<MediaAudioData[]> {
  return new Promise((resolve) => {
    const chunks: MediaAudioData[] = [];
    source.listen({
      audio(data) {
        if (chunks.length === count) return;
        chunks.push(data);
        if (chunks.length === count) {
          source.stop();
          resolve(chunks);
        }
      },
      muted() {},
      ended() {},
    });
  });
}

/** The frame number the pattern writes along a frame's bottom row. */
function frameNumber(frame: MediaVideoFrame): number {
  const cell = Math.floor(frame.width / 16);
  const row = (frame.height - 1) * frame.strides[0];
  let n = 0;
  for (let bit = 0; bit < 16; bit++) {
    n =
      (n << 1) |
      (frame.planes[0][row + bit * cell + (cell >> 1)] > 128 ? 1 : 0);
  }
  return n;
}

test('no devices by default: none listed, and opening one is NotFoundError', async () => {
  assert.deepEqual(await NO_MEDIA_DEVICES.devices(), []);
  await assert.rejects(NO_MEDIA_DEVICES.open('any', {}), (error: Error) => {
    assert.equal(error.name, 'NotFoundError');
    assert.match(error.message, /scripts\.mediaDevices/);
    return true;
  });
});

test('no stack by default: a connection takes transceivers, and its operations are NotSupportedError', async () => {
  const pc = NO_WEBRTC.connect(REQUEST, NO_EVENTS);
  const t = pc.addTransceiver({
    kind: 'video',
    direction: 'sendrecv',
    source: null,
    trackId: null,
    streams: [],
    sendEncodings: [],
  });
  assert.equal(t.kind, 'video');
  assert.equal(t.received.kind, 'video');
  let muted: boolean | null = null;
  t.received.listen({ muted: (m) => (muted = m), ended() {} });
  assert.equal(muted, true, "a receiver's source is muted until media comes");
  assert.equal(t.sendTone('1', 100), false);
  for (const operation of [
    () => pc.createOffer({ iceRestart: false }),
    () => pc.createAnswer(),
    () => pc.setLocalDescription('offer', ''),
    () => pc.setRemoteDescription('offer', 'v=0'),
    () => pc.addIceCandidate(null),
    () =>
      NO_WEBRTC.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }, 0),
  ]) {
    await assert.rejects(operation(), (error: Error) => {
      assert.equal(error.name, 'NotSupportedError');
      assert.match(error.message, /scripts\.webRTC/);
      return true;
    });
  }
  assert.deepEqual(pc.descriptions(), {
    currentLocal: null,
    pendingLocal: null,
    currentRemote: null,
    pendingRemote: null,
  });
  assert.deepEqual(await pc.stats(), []);
  const channel = pc.createDataChannel({
    label: 'x',
    ordered: true,
    maxPacketLifeTime: null,
    maxRetransmits: null,
    protocol: '',
    negotiated: false,
    id: null,
    priority: 'low',
  });
  channel.send('never sent');
  channel.close();
  assert.equal(NO_WEBRTC.capabilities('audio', 'sender'), null);
  pc.close();
});

test('an idle source gives nothing, and is muted', async () => {
  const source = idleSource('audio', 'Remote');
  assert.equal(source.label, 'Remote');
  const told: boolean[] = [];
  source.listen({ muted: (m) => told.push(m), ended() {} });
  assert.deepEqual(told, [true]);
  assert.equal(await source.reconfigure({ sampleRate: 8000 }), false);
});

test('fake devices: a camera, a microphone and a speaker, each in its group', async () => {
  const devices = await fakeMediaDevices().devices();
  assert.deepEqual(
    devices.map((d) => [d.kind, d.label]),
    [
      ['videoinput', 'Fake camera'],
      ['audioinput', 'Fake microphone'],
      ['audiooutput', 'Fake speaker'],
    ],
  );
  assert.equal(devices[1].groupId, devices[2].groupId);
  assert.notEqual(devices[0].groupId, devices[1].groupId);
  const none = await fakeMediaDevices({
    camera: false,
    microphone: false,
  }).devices();
  assert.deepEqual(none, []);
});

test("fake camera: I420 frames at the size asked, each one's number drawn in it", async () => {
  const media = fakeMediaDevices();
  const camera = (await media.devices()).find((d) => d.kind === 'videoinput')!;
  const source = await media.open(camera.deviceId, {
    width: 320,
    height: 240,
    frameRate: 60,
  });
  assert.equal(source.kind, 'video');
  assert.deepEqual(
    { ...source.settings() },
    {
      ...camera.defaults,
      width: 320,
      height: 240,
      frameRate: 60,
    },
  );
  const frames = await videoFrames(source, 3);
  for (const frame of frames) {
    assert.equal(frame.width, 320);
    assert.equal(frame.height, 240);
    assert.deepEqual(frame.strides, [320, 160, 160]);
    assert.deepEqual(
      frame.planes.map((p) => p.length),
      [320 * 240, 160 * 120, 160 * 120],
    );
  }
  assert.deepEqual(frames.map(frameNumber), [0, 1, 2]);
  assert.notDeepEqual(frames[0].planes[0], frames[1].planes[0]);
  assert.ok(frames[1].timestamp >= frames[0].timestamp);
});

test('fake camera: an odd size has its chroma rounded up, and a size past it is held to it', async () => {
  const media = fakeMediaDevices();
  const odd = await media.open('fake-camera', { width: 33, height: 17 });
  const [frame] = await videoFrames(odd, 1);
  assert.deepEqual(frame.strides, [33, 17, 17]);
  assert.deepEqual(
    frame.planes.map((p) => p.length),
    [33 * 17, 17 * 9, 17 * 9],
  );
  const big = await media.open('fake-camera', { width: 5000, height: 5000 });
  assert.equal(big.settings().width, 1920);
  assert.equal(big.settings().height, 1080);
  big.stop();
});

test('fake camera: reconfigured, it draws at the new size', async () => {
  const media = fakeMediaDevices();
  const source = await media.open('fake-camera', {});
  assert.equal(await source.reconfigure({ width: 160, height: 120 }), true);
  const [frame] = await videoFrames(source, 1);
  assert.equal(frame.width, 160);
  assert.equal(frame.height, 120);
});

test('fake microphone: 10 ms chunks of a tone, a channel each as asked', async () => {
  const media = fakeMediaDevices();
  const source = await media.open('fake-microphone', { channelCount: 2 });
  assert.equal(source.kind, 'audio');
  const chunks = await audioChunks(source, 3);
  for (const chunk of chunks) {
    assert.equal(chunk.sampleRate, 48000);
    assert.equal(chunk.frames, 480);
    assert.equal(chunk.channels.length, 2);
    assert.deepEqual(chunk.channels[0], chunk.channels[1]);
  }
  assert.deepEqual(
    chunks.map((c) => c.timestamp),
    [0, 10000, 20000],
  );
  const peak = Math.max(...chunks[0].channels[0].map(Math.abs));
  assert.ok(peak > 0.09 && peak < 0.1 + 1e-6, `peak ${peak}`);
});

test('a stopped fake source gives no more frames, and tells no end', async () => {
  const media = fakeMediaDevices();
  const source = await media.open('fake-camera', { frameRate: 60 });
  let frames = 0;
  let ended = false;
  source.listen({
    video: () => {
      frames += 1;
    },
    muted() {},
    ended: () => (ended = true),
  });
  source.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(frames, 0);
  assert.equal(ended, false);
});

test('fake devices: what is not there, or only plays, is NotFoundError', async () => {
  const media = fakeMediaDevices({ camera: false });
  for (const id of ['fake-camera', 'fake-speaker', 'nothing']) {
    await assert.rejects(media.open(id, {}), { name: 'NotFoundError' });
  }
});

test('fake devices: allowed until a test says otherwise', async () => {
  const media = fakeMediaDevices();
  const ask = {
    origin: 'https://example.test',
    camera: true,
    microphone: true,
    display: false,
  };
  assert.equal(media.permission!('camera', ask.origin), 'granted');
  assert.equal(await media.request!(ask), true);
  media.setPermission('microphone', 'denied');
  assert.equal(media.permission!('microphone', ask.origin), 'denied');
  assert.equal(await media.request!(ask), false);
  assert.equal(await media.request!({ ...ask, microphone: false }), true);
  const prompted = fakeMediaDevices({ permission: 'prompt' });
  assert.equal(prompted.permission!('camera', ask.origin), 'prompt');
  assert.equal(
    await prompted.request!(ask),
    true,
    "a prompt is answered as an automated browser's is",
  );
});

test('fake display: a 1280×720 screen, or none', async () => {
  const media = fakeMediaDevices();
  const ask = {
    origin: 'https://example.test',
    camera: false,
    microphone: false,
    display: true,
  };
  const screen = await media.display!(ask);
  assert.ok(screen);
  assert.equal(screen.label, 'Fake screen');
  const [frame] = await videoFrames(screen, 1);
  assert.equal(frame.width, 1280);
  assert.equal(frame.height, 720);
  assert.equal(fakeMediaDevices({ display: false }).display, undefined);
});
