// Devices that are not there: a camera that draws a test pattern, a
// microphone that plays a tone and a screen to capture, behind the
// `HtmlMediaDevices` seam (`./media-devices.ts`) — what a browser's fake
// devices are to its own tests (Chrome's `--use-fake-device-for-media-stream`),
// and what the WPT runner hands a page whose `getUserMedia` WebRTC's tests
// fall back to. An application can hand them too, to show a call working
// with no camera on the machine.
//
// A source makes frames only while something listens and it is not stopped,
// and its timer does not keep the process alive.

import { mediaError } from './media-devices.js';
import type {
  HtmlMediaDevices,
  MediaDeviceCapabilities,
  MediaDeviceDescription,
  MediaPermission,
  MediaSettings,
  MediaSourceEvents,
  MediaSourceLike,
} from './media-devices.js';

declare const setInterval: (fn: () => void, ms: number) => unknown;
declare const clearInterval: (handle: unknown) => void;

/** What `fakeMediaDevices` has. */
export interface FakeMediaOptions {
  /** A camera. Default true. */
  camera?: boolean;
  /** A microphone. Default true. */
  microphone?: boolean;
  /** A screen `getDisplayMedia` captures. Default true. */
  display?: boolean;
  /** What a page is answered for each kind until `setPermission` changes
   *  it. Default `'granted'`. */
  permission?: MediaPermission;
}

/** Fake devices, and what a test changes of them. */
export interface FakeMediaDevices extends HtmlMediaDevices {
  /** What a page is answered for a kind from now on: a page asked
   *  `'prompt'` is let have it, as an automated browser's prompt is. */
  setPermission(
    name: 'camera' | 'microphone' | 'display',
    state: MediaPermission,
  ): void;
}

const CAMERA = 'fake-camera';
const MICROPHONE = 'fake-microphone';
const SPEAKER = 'fake-speaker';

const CAMERA_CAPABILITIES: MediaDeviceCapabilities = {
  width: { min: 1, max: 1920 },
  height: { min: 1, max: 1080 },
  aspectRatio: { min: 1 / 1080, max: 1920 },
  frameRate: { min: 1, max: 60 },
  facingMode: ['user'],
  resizeMode: ['none', 'crop-and-scale'],
};

const MICROPHONE_CAPABILITIES: MediaDeviceCapabilities = {
  sampleRate: { min: 48000, max: 48000 },
  sampleSize: { min: 16, max: 16 },
  channelCount: { min: 1, max: 2 },
  latency: { min: 0.01, max: 0.01 },
  echoCancellation: [true, false],
  autoGainControl: [true, false],
  noiseSuppression: [true, false],
};

/** Bars across, as a television's test card has them, in Y, Cb, Cr: white,
 *  yellow, cyan, green, magenta, red, blue, black. */
const BARS: [number, number, number][] = [
  [235, 128, 128],
  [210, 16, 146],
  [170, 166, 16],
  [145, 54, 34],
  [106, 202, 222],
  [81, 90, 240],
  [41, 240, 110],
  [16, 128, 128],
];

const clamp = (value: number, range: { min: number; max: number }) =>
  Math.min(range.max, Math.max(range.min, value));

/** A timer that does not keep the process alive: a source left running in
 *  a test would hang it otherwise. */
function every(ms: number, fn: () => void): unknown {
  const handle = setInterval(fn, ms);
  (handle as { unref?(): void }).unref?.();
  return handle;
}

/**
 * A video source drawing bars with a band of white moving down them a row
 * a frame, so that two frames are never alike, and a frame's number in a
 * strip of black and white squares along the bottom, its bits from the
 * left.
 */
function patternSource(
  label: string,
  capabilities: MediaDeviceCapabilities,
  initial: MediaSettings,
): MediaSourceLike {
  let settings = { ...initial };
  let events: MediaSourceEvents | null = null;
  let timer: unknown = null;
  let stopped = false;
  let count = 0;
  let planes: [Uint8Array, Uint8Array, Uint8Array] | null = null;
  let still: [Uint8Array, Uint8Array, Uint8Array] | null = null;
  const start = Date.now();

  const size = () => ({
    width: Math.max(1, Math.round(settings.width ?? 640)),
    height: Math.max(1, Math.round(settings.height ?? 480)),
  });

  // the bars, which each frame is drawn over; the chroma planes are half
  // the size each way, an odd size's rounded up
  const background = (width: number, height: number) => {
    const cw = (width + 1) >> 1;
    const ch = (height + 1) >> 1;
    const y = new Uint8Array(width * height);
    const cb = new Uint8Array(cw * ch);
    const cr = new Uint8Array(cw * ch);
    const barOf = (x: number) =>
      BARS[Math.min(BARS.length - 1, Math.floor((x * BARS.length) / width))];
    for (let x = 0; x < width; x++) y[x] = barOf(x)[0];
    for (let row = 1; row < height; row++) y.copyWithin(row * width, 0, width);
    for (let x = 0; x < cw; x++) {
      cb[x] = barOf(x * 2)[1];
      cr[x] = barOf(x * 2)[2];
    }
    for (let row = 1; row < ch; row++) {
      cb.copyWithin(row * cw, 0, cw);
      cr.copyWithin(row * cw, 0, cw);
    }
    return [y, cb, cr] as [Uint8Array, Uint8Array, Uint8Array];
  };

  const frame = () => {
    if (!events?.video || stopped) return;
    const { width, height } = size();
    if (!still || still[0].length !== width * height) {
      still = background(width, height);
      planes = [
        new Uint8Array(still[0].length),
        new Uint8Array(still[1].length),
        new Uint8Array(still[2].length),
      ];
    }
    const [y, cb, cr] = planes!;
    y.set(still[0]);
    cb.set(still[1]);
    cr.set(still[2]);
    // the band
    const band = Math.max(1, height >> 5);
    const top = (count * 2) % height;
    for (let row = top; row < Math.min(height, top + band); row++) {
      y.fill(235, row * width, (row + 1) * width);
    }
    // the frame's number, 16 bits along the bottom
    const cell = Math.max(1, Math.floor(width / 16));
    const strip = Math.min(height, cell);
    for (let bit = 0; bit < 16 && (bit + 1) * cell <= width; bit++) {
      const on = (count >> (15 - bit)) & 1 ? 235 : 16;
      for (let row = height - strip; row < height; row++) {
        y.fill(on, row * width + bit * cell, row * width + (bit + 1) * cell);
      }
    }
    events.video({
      width,
      height,
      planes: planes!,
      strides: [width, (width + 1) >> 1, (width + 1) >> 1],
      timestamp: (Date.now() - start) * 1000,
    });
    count += 1;
  };

  const run = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (stopped || !events) return;
    timer = every(1000 / (settings.frameRate ?? 30), frame);
  };

  return {
    kind: 'video',
    label,
    listen(next) {
      events = next;
      next.muted(false);
      run();
    },
    settings: () => ({ ...settings, ...size() }),
    capabilities: () => capabilities,
    reconfigure(next) {
      settings = { ...settings, ...fitted(next, capabilities) };
      run();
      return Promise.resolve(true);
    },
    stop() {
      stopped = true;
      run();
    },
  };
}

/** An audio source playing a 440 Hz tone at a tenth of full scale, in
 *  10 ms chunks, as many a tick as the clock says are due. */
function toneSource(initial: MediaSettings): MediaSourceLike {
  let settings = { ...initial };
  let events: MediaSourceEvents | null = null;
  let timer: unknown = null;
  let stopped = false;
  let made = 0;
  let begun = 0;

  const chunk = () => {
    if (!events?.audio || stopped) return;
    const rate = settings.sampleRate ?? 48000;
    const frames = rate / 100;
    const due = Math.floor(((Date.now() - begun) * rate) / 1000 / frames);
    for (; made < due; made++) {
      const channels: Float32Array[] = [];
      for (let c = 0; c < (settings.channelCount ?? 1); c++) {
        channels.push(new Float32Array(frames));
      }
      for (let i = 0; i < frames; i++) {
        const t = (made * frames + i) / rate;
        const sample = 0.1 * Math.sin(2 * Math.PI * 440 * t);
        for (const channel of channels) channel[i] = sample;
      }
      events.audio({
        sampleRate: rate,
        channels,
        frames,
        timestamp: (made * frames * 1e6) / rate,
      });
    }
  };

  const run = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (stopped || !events) return;
    timer = every(10, chunk);
  };

  return {
    kind: 'audio',
    label: 'Fake microphone',
    listen(next) {
      events = next;
      begun = Date.now();
      made = 0;
      next.muted(false);
      run();
    },
    settings: () => ({ ...settings }),
    capabilities: () => MICROPHONE_CAPABILITIES,
    reconfigure(next) {
      settings = { ...settings, ...fitted(next, MICROPHONE_CAPABILITIES) };
      return Promise.resolve(true);
    },
    stop() {
      stopped = true;
      run();
    },
  };
}

/** Settings held to what a device can do. */
function fitted(
  settings: MediaSettings,
  capabilities: MediaDeviceCapabilities,
): MediaSettings {
  const out: MediaSettings = { ...settings };
  for (const key of [
    'width',
    'height',
    'frameRate',
    'sampleRate',
    'channelCount',
  ] as const) {
    const range = capabilities[key];
    if (range && out[key] !== undefined) out[key] = clamp(out[key]!, range);
  }
  return out;
}

/**
 * Fake media devices: a camera at 640×480 and 30 frames a second, a
 * microphone at 48 kHz, a speaker for `enumerateDevices` to list, and a
 * 1280×720 screen, every one allowed unless the options or `setPermission`
 * say otherwise.
 */
export function fakeMediaDevices(
  options: FakeMediaOptions = {},
): FakeMediaDevices {
  const allowed = options.permission ?? 'granted';
  const permissions = {
    camera: allowed,
    microphone: allowed,
    display: allowed,
  };
  const list: MediaDeviceDescription[] = [];
  if (options.camera ?? true) {
    list.push({
      deviceId: CAMERA,
      groupId: CAMERA,
      kind: 'videoinput',
      label: 'Fake camera',
      capabilities: CAMERA_CAPABILITIES,
      defaults: {
        width: 640,
        height: 480,
        aspectRatio: 640 / 480,
        frameRate: 30,
        facingMode: 'user',
        resizeMode: 'none',
      },
    });
  }
  if (options.microphone ?? true) {
    list.push(
      {
        deviceId: MICROPHONE,
        groupId: MICROPHONE,
        kind: 'audioinput',
        label: 'Fake microphone',
        capabilities: MICROPHONE_CAPABILITIES,
        defaults: {
          sampleRate: 48000,
          sampleSize: 16,
          channelCount: 1,
          latency: 0.01,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      },
      {
        deviceId: SPEAKER,
        groupId: MICROPHONE,
        kind: 'audiooutput',
        label: 'Fake speaker',
        capabilities: {},
        defaults: {},
      },
    );
  }
  const display = options.display ?? true;

  return {
    devices: () => Promise.resolve(list.map((d) => ({ ...d }))),
    permission: (name) => permissions[name],
    request: (ask) =>
      Promise.resolve(
        !(
          (ask.camera && permissions.camera === 'denied') ||
          (ask.microphone && permissions.microphone === 'denied') ||
          (ask.display && permissions.display === 'denied')
        ),
      ),
    open(deviceId, settings) {
      const device = list.find((d) => d.deviceId === deviceId);
      if (!device || device.kind === 'audiooutput') {
        return Promise.reject(
          mediaError('NotFoundError', `There is no ${deviceId}.`),
        );
      }
      const at = {
        ...device.defaults,
        ...fitted(settings, device.capabilities),
      };
      return Promise.resolve(
        device.kind === 'videoinput'
          ? patternSource(device.label, device.capabilities, at)
          : toneSource(at),
      );
    },
    display: display
      ? () =>
          Promise.resolve(
            patternSource(
              'Fake screen',
              {
                width: { min: 1, max: 1280 },
                height: { min: 1, max: 720 },
                frameRate: { min: 1, max: 30 },
              },
              { width: 1280, height: 720, frameRate: 30 },
            ),
          )
      : undefined,
    setPermission(name, state) {
      permissions[name] = state;
    },
  };
}
