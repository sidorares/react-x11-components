// Media Capture's constrainable pattern on the host's side
// (`src/html/scripts/constraints.ts`): SelectSettings over a source's
// settings dictionaries, with nothing of a page's realm in it. What a page
// sees of it, through `getUserMedia` and `applyConstraints`, is in
// `mediastream.test.ts`; WPT's `mediacapture-streams` holds both.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectSettings } from '../../src/html/scripts/constraints.js';
import type {
  Constrainable,
  ConstraintSet,
} from '../../src/html/scripts/constraints.js';

const CAMERA: Constrainable = {
  kind: 'video',
  deviceId: 'cam',
  groupId: 'cam-group',
  capabilities: {
    width: { min: 1, max: 1920 },
    height: { min: 1, max: 1080 },
    aspectRatio: { min: 1 / 1080, max: 1920 },
    frameRate: { min: 1, max: 60 },
    facingMode: ['user'],
    resizeMode: ['none', 'crop-and-scale'],
  },
  defaults: { width: 640, height: 480, frameRate: 30, facingMode: 'user' },
  modes: [
    { width: 640, height: 480, frameRate: 30 },
    { width: 1280, height: 720, frameRate: 30 },
  ],
};

const MICROPHONE: Constrainable = {
  kind: 'audio',
  deviceId: 'mic',
  groupId: 'mic-group',
  capabilities: {
    sampleRate: { min: 48000, max: 48000 },
    channelCount: { min: 1, max: 2 },
    echoCancellation: [true, false, 'remote-only', 'all'],
    autoGainControl: [true, false],
  },
  defaults: {
    sampleRate: 48000,
    channelCount: 1,
    echoCancellation: true,
    autoGainControl: true,
  },
};

const settings = (sources: Constrainable[], c: ConstraintSet) => {
  const got = selectSettings(sources, c);
  assert.ok(!('failed' in got), `failed: ${JSON.stringify(got)}`);
  return got;
};
const failed = (sources: Constrainable[], c: ConstraintSet) => {
  const got = selectSettings(sources, c);
  return 'failed' in got ? got.failed : null;
};

test('nothing asked is the default mode at its native size, unscaled', () => {
  const { settings: s } = settings([CAMERA], {});
  assert.deepEqual(s, {
    width: 640,
    height: 480,
    aspectRatio: 640 / 480,
    frameRate: 30,
    resizeMode: 'none',
    facingMode: 'user',
    deviceId: 'cam',
    groupId: 'cam-group',
  });
});

test('an ideal is met by a native mode where one has it, and scaled to where none does', () => {
  // 1280 is a mode of its own: no scaling
  const wide = settings([CAMERA], { width: 1280 }).settings;
  assert.equal(wide.width, 1280);
  assert.equal(wide.height, 720);
  assert.equal(wide.resizeMode, 'none');
  // 320 is no mode: scaled from the default one, its ratio kept
  const small = settings([CAMERA], { width: { ideal: 320, min: 160 } });
  assert.equal(small.settings.width, 320);
  assert.equal(small.settings.height, 240);
  assert.equal(small.settings.resizeMode, 'crop-and-scale');
  assert.equal(small.distance, 0);
});

test('a required constraint nothing can meet is named, in the order a device is narrowed', () => {
  for (const [c, name] of [
    [{ width: { min: 100000000 } }, 'width'],
    [{ width: { max: 0 } }, 'width'],
    [{ height: { max: 0 } }, 'height'],
    [{ frameRate: { max: 0 } }, 'frameRate'],
    // `[Clamp] unsigned long`: -1 is 0
    [{ width: { max: -1 } }, 'width'],
    [{ frameRate: { max: -1 } }, 'frameRate'],
    [{ width: { min: 100, max: 10 } }, 'width'],
    [{ facingMode: { exact: '' } }, 'facingMode'],
    [{ resizeMode: { exact: 'INVALID' } }, 'resizeMode'],
    [{ groupId: { exact: 'INVALID' } }, 'groupId'],
    [{ deviceId: { exact: ['a', 'b'] } }, 'deviceId'],
    // no one constraint fails every dictionary: `none` narrows the modes
    // first, as Chromium does, and then no mode is 639 wide
    [{ width: { exact: 639 }, resizeMode: { exact: 'none' } }, 'width'],
  ] as [ConstraintSet, string][]) {
    assert.equal(failed([CAMERA], c), name, JSON.stringify(c));
  }
});

test('what is ideal and cannot be had changes nothing, and is no failure', () => {
  const s = settings([CAMERA], {
    resizeMode: 'INVALID',
    groupId: 'INVALID',
    facingMode: 'environment',
  }).settings;
  assert.equal(s.resizeMode, 'none');
  assert.equal(s.groupId, 'cam-group');
  assert.equal(s.facingMode, 'user');
});

test('crop-and-scale goes below a mode, and decimates', () => {
  const s = settings([CAMERA], {
    resizeMode: { exact: 'crop-and-scale' },
    width: { max: 30 },
    frameRate: { max: 5 },
  }).settings;
  assert.equal(s.resizeMode, 'crop-and-scale');
  assert.ok(s.width! <= 30, `width ${s.width}`);
  assert.equal(s.height, Math.round((s.width! * 480) / 640));
  assert.equal(s.frameRate, 5);
  // and without scaling, where nothing asks for less
  const whole = settings([CAMERA], {
    resizeMode: { exact: 'crop-and-scale' },
  }).settings;
  assert.equal(whole.width, 640);
});

test('an aspect ratio asked for holds width and height to it', () => {
  const s = settings([CAMERA], {
    aspectRatio: { exact: 1 },
    width: 400,
  }).settings;
  assert.equal(s.width, 400);
  assert.equal(s.height, 400);
  assert.equal(s.aspectRatio, 1);
  assert.equal(failed([CAMERA], { aspectRatio: { min: 3000 } }), 'aspectRatio');
});

test('the advanced sets narrow in turn, and one nothing meets is passed over', () => {
  const s = settings([CAMERA], {
    advanced: [{ width: 1280 }, { width: 333 }, { frameRate: { max: 15 } }],
  }).settings;
  // bare values in `advanced` are exact: 1280 holds, 333 cannot with it
  assert.equal(s.width, 1280);
  assert.equal(s.frameRate, 15);
});

test('devices: the one the constraints fit best, the first among equals', () => {
  const other: Constrainable = { ...CAMERA, deviceId: 'b', groupId: 'g2' };
  assert.equal(settings([CAMERA, other], {}).index, 0);
  assert.equal(settings([CAMERA, other], { deviceId: 'b' }).index, 1);
  assert.equal(
    settings([CAMERA, other], { groupId: { exact: 'g2' } }).index,
    1,
  );
  assert.equal(
    failed([CAMERA, other], { groupId: { exact: 'mic' } }),
    'groupId',
  );
});

test('a microphone: echo cancellation by mode as well as by boolean, and what does not apply to audio ignored', () => {
  assert.equal(
    settings([MICROPHONE], { echoCancellation: { exact: 'all' } }).settings
      .echoCancellation,
    'all',
  );
  assert.equal(
    settings([MICROPHONE], { echoCancellation: 'remote-only' }).settings
      .echoCancellation,
    'remote-only',
  );
  assert.equal(
    settings([MICROPHONE], { echoCancellation: false }).settings
      .echoCancellation,
    false,
  );
  // a camera's constraint on a microphone does not apply, required or not
  const s = settings([MICROPHONE], {
    width: { exact: 5 },
    channelCount: 2,
  }).settings;
  assert.equal(s.channelCount, 2);
  assert.equal((s as Record<string, unknown>).width, undefined);
  assert.equal(
    failed([MICROPHONE], { sampleRate: { exact: 8000 } }),
    'sampleRate',
  );
});

test('a source that is no device has the one dictionary it runs at', () => {
  const canvas: Constrainable = {
    kind: 'video',
    capabilities: {},
    defaults: {},
    fixed: { width: 300, height: 150, resizeMode: 'none' },
  };
  assert.equal(settings([canvas], { width: 640 }).settings.width, 300);
  assert.equal(failed([canvas], { width: { exact: 640 } }), 'width');
  // and no device's ids: a required one cannot be met
  assert.equal(failed([canvas], { deviceId: { exact: 'cam' } }), 'deviceId');
});
