// What a page's media comes from: the devices `navigator.mediaDevices` lists
// and opens (`HtmlScripts.mediaDevices`), and the one shape every source of
// a `MediaStreamTrack` has, a camera's and a remote peer's alike
// (`MediaSourceLike`). The page's realm has the W3C API (Media Capture and
// Streams): `MediaStream` and `MediaStreamTrack`, constraints and the
// settings they come to, what a page may see of a device before it is
// allowed one, a device's id kept apart for each origin. What reaches this
// seam is the devices themselves, and their frames.
//
// **No device is there by default** (`NO_MEDIA_DEVICES`): a page lists none,
// and its `getUserMedia` rejects as on a machine with no camera and no
// microphone. `fakeMediaDevices` (`./fake-media.ts`) is a camera, a
// microphone and a screen that draw a test pattern and play a tone, as a
// browser's fake devices do for its tests; a real one is the host's.
//
// The frames stay host-side. A track in the page is a number for a source
// here, and what reads its frames — a `<video srcObject>`, the encoder a
// peer connection sends them through — is host-side too
// (docs/prd-webrtc.md).
//
// Light on purpose: `<Html>` reaches it whether or not a document runs
// scripts.

import type { MediaStream as CoreMediaStream } from 'react-x11';

/** What `enumerateDevices()` lists a device as. */
export type MediaDeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';

/** A range a setting can take: Media Capture's `ULongRange` and
 *  `DoubleRange`, both ends known. */
export interface MediaRange {
  min: number;
  max: number;
}

/**
 * What a device can do: the part of `MediaTrackCapabilities` the page's
 * constraints are fitted to. A field left out is one the device has no
 * setting for, which a constraint on it does not stop.
 */
export interface MediaDeviceCapabilities {
  width?: MediaRange;
  height?: MediaRange;
  aspectRatio?: MediaRange;
  frameRate?: MediaRange;
  facingMode?: string[];
  resizeMode?: string[];
  sampleRate?: MediaRange;
  sampleSize?: MediaRange;
  channelCount?: MediaRange;
  latency?: MediaRange;
  /** `true` and `false`, and the modes of it it has: `'all'` (whatever
   *  the system plays) and `'remote-only'` (what it receives from a peer). */
  echoCancellation?: (boolean | EchoCancellationMode)[];
  autoGainControl?: boolean[];
  noiseSuppression?: boolean[];
  /** Media Capture Extensions' voice isolation. */
  voiceIsolation?: boolean[];
  /** A display's: what it captures, as its settings say. */
  displaySurface?: string;
  logicalSurface?: boolean;
  cursor?: string[];
}

/** The modes of echo cancellation a page may ask for by name. */
export type EchoCancellationMode = 'all' | 'remote-only';

/**
 * A mode a camera runs at natively: what `resizeMode: 'none'` holds a
 * track to. Anything smaller, or slower, it is cropped, scaled or decimated
 * to (`'crop-and-scale'`).
 */
export interface MediaMode {
  width: number;
  height: number;
  frameRate: number;
}

/** The settings a source runs at: `MediaTrackSettings`, less the device's
 *  ids, which the page's realm keeps apart for each origin. */
export interface MediaSettings {
  width?: number;
  height?: number;
  aspectRatio?: number;
  frameRate?: number;
  facingMode?: string;
  resizeMode?: string;
  sampleRate?: number;
  sampleSize?: number;
  channelCount?: number;
  latency?: number;
  echoCancellation?: boolean | EchoCancellationMode;
  autoGainControl?: boolean;
  noiseSuppression?: boolean;
  voiceIsolation?: boolean;
  /** A display's (Screen Capture): what it captures — `'monitor'`,
   *  `'window'` or `'browser'` — whether that is all of it, and whether
   *  the pointer is drawn in — `'always'`, `'motion'` or `'never'`. */
  displaySurface?: string;
  logicalSurface?: boolean;
  cursor?: string;
  /** A display's audio: whether this application's own sound is left
   *  out of what is heard of it, and out of what is captured. */
  suppressLocalAudioPlayback?: boolean;
  restrictOwnAudio?: boolean;
}

/** A device, as the host has it. */
export interface MediaDeviceDescription {
  /** Stable for the device across a page's loads. The page is handed a
   *  digest of it and its origin, never this. */
  deviceId: string;
  /** Shared by the devices of one piece of hardware — a camera and its
   *  microphone. Digested as `deviceId` is. */
  groupId: string;
  kind: MediaDeviceKind;
  /** What the user would call it, which a page sees only once it is
   *  allowed the kind. */
  label: string;
  capabilities: MediaDeviceCapabilities;
  /** What a track of it runs at where the page's constraints leave a
   *  setting open. */
  defaults: MediaSettings;
  /**
   * A camera's native modes, the first its default. Absent, its one mode is
   * its `defaults`' size and rate.
   */
  modes?: MediaMode[];
}

/** Whether a page may have a kind of device: the Permissions API's
 *  states. */
export type MediaPermission = 'granted' | 'denied' | 'prompt';

/** What a `getUserMedia` or a `getDisplayMedia` asks to be allowed. */
export interface MediaPermissionRequest {
  /** The page's origin. */
  origin: string;
  camera: boolean;
  microphone: boolean;
  /** A screen, a window or a tab (`getDisplayMedia`). */
  display: boolean;
}

/**
 * How a video frame's bytes are laid out, as core's `VideoFrames` has it:
 * `'I420'`, a Y plane then Cb and Cr at half the size each way (`yuv420p`,
 * what libvpx encodes from); `'NV12'`, a Y plane then one of Cb/Cr pairs at
 * half the size each way (a camera's on macOS); `'BGRA'`, four bytes a
 * pixel, blue first, the fourth ignored (a screen's on X11).
 */
export type MediaVideoFormat = 'I420' | 'NV12' | 'BGRA';

/**
 * One frame of video, in the format its source delivers it in: converted
 * only where a reader needs another (`toI420`), so a camera shown by a
 * `VideoFrames` sink is never converted at all.
 */
export interface MediaVideoFrame {
  /** I420 where it says nothing. */
  format?: MediaVideoFormat;
  width: number;
  height: number;
  /** Y, Cb, Cr for I420; Y and CbCr for NV12; one plane for BGRA. Read
   *  until the next frame and not after it: what keeps a frame copies
   *  it. */
  planes: Uint8Array[];
  /** Each plane's bytes per row. */
  strides: number[];
  /** What its YCbCr numbers mean, where the source says: `'bt601'` where
   *  it does not. */
  colorSpace?: 'bt709' | 'bt601' | 'bt2020';
  /** `'video'` (black at 16) where the source says nothing. */
  range?: 'video' | 'full';
  /** When it was captured, in microseconds on the source's clock, as
   *  WebCodecs' `timestamp`. */
  timestamp: number;
}

/**
 * A frame as I420, which an encoder reads: the frame itself where it is
 * I420 already, and a copy converted from NV12 or BGRA (BT.601 at video
 * range, a chroma sample the mean of the four pixels it covers) where not.
 */
export function toI420(frame: MediaVideoFrame): MediaVideoFrame {
  const format = frame.format ?? 'I420';
  if (format === 'I420') return frame;
  const { width, height } = frame;
  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  const y = new Uint8Array(width * height);
  const cb = new Uint8Array(cw * ch);
  const cr = new Uint8Array(cw * ch);
  if (format === 'NV12') {
    const [py, puv] = frame.planes;
    const [sy, suv] = frame.strides;
    for (let row = 0; row < height; row++) {
      y.set(py.subarray(row * sy, row * sy + width), row * width);
    }
    for (let row = 0; row < ch; row++) {
      for (let x = 0; x < cw; x++) {
        cb[row * cw + x] = puv[row * suv + x * 2];
        cr[row * cw + x] = puv[row * suv + x * 2 + 1];
      }
    }
  } else {
    const [bgra] = frame.planes;
    const [stride] = frame.strides;
    for (let row = 0; row < height; row++) {
      for (let x = 0; x < width; x++) {
        const i = row * stride + x * 4;
        y[row * width + x] =
          (16 +
            (65.738 * bgra[i + 2] + 129.057 * bgra[i + 1] + 25.064 * bgra[i]) /
              256 +
            0.5) |
          0;
      }
    }
    for (let row = 0; row < ch; row++) {
      for (let x = 0; x < cw; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = 0; dy < 2 && row * 2 + dy < height; dy++) {
          for (let dx = 0; dx < 2 && x * 2 + dx < width; dx++) {
            const i = (row * 2 + dy) * stride + (x * 2 + dx) * 4;
            b += bgra[i];
            g += bgra[i + 1];
            r += bgra[i + 2];
            n++;
          }
        }
        r /= n;
        g /= n;
        b /= n;
        cb[row * cw + x] =
          (128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256 + 0.5) | 0;
        cr[row * cw + x] =
          (128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256 + 0.5) | 0;
      }
    }
  }
  return {
    format: 'I420',
    width,
    height,
    planes: [y, cb, cr],
    strides: [width, cw, cw],
    colorSpace: frame.colorSpace,
    range: frame.range,
    timestamp: frame.timestamp,
  };
}

/**
 * A chunk of audio, planar floats from -1 to 1 — Web Audio's and WebCodecs'
 * `f32-planar` — 10 ms of it, which is what a peer connection sends audio
 * a frame of at a time.
 */
export interface MediaAudioData {
  sampleRate: number;
  /** One array a channel, each `frames` long. Read until the next chunk. */
  channels: Float32Array[];
  frames: number;
  /** Its first sample's time, in microseconds on the source's clock. */
  timestamp: number;
}

/** What becomes of a source, told as it happens. */
export interface MediaSourceEvents {
  /** A frame, where it is a video source and the listener reads frames. */
  video?(frame: MediaVideoFrame): void;
  /** A chunk, where it is an audio source and the listener reads them. */
  audio?(data: MediaAudioData): void;
  /**
   * It gives no frames for now, or gives them again: a track's `mute` and
   * `unmute`. A remote peer's source is muted until its media arrives.
   */
  muted(muted: boolean): void;
  /** It will give no more — unplugged, taken back, the peer's track gone —
   *  and the tracks of it end. Told once, and nothing after it. */
  ended(): void;
  /** What it runs at changed — a camera at another size, a screen
   *  captured at another — where the source can tell. */
  changed?(): void;
}

/**
 * Where a track's frames come from: a device `open` opened, a screen, or
 * what a peer connection's receiver receives. Every track of it — a clone
 * is another track of the same source — is the host's to count, and the
 * source is stopped once the last of them is.
 */
export interface MediaSourceLike {
  readonly kind: 'audio' | 'video';
  /** What a track of it is labelled. */
  readonly label: string;
  /**
   * Starts telling its events, to one listener: the host hands each frame
   * on to whatever reads it. Called again, the events it is handed replace
   * the last: the host listens with `video` or `audio` only while something
   * reads frames, and a source makes them only for a listener that does,
   * since a camera's frames cost a copy into JavaScript.
   */
  listen(events: MediaSourceEvents): void;
  /** What it runs at now. */
  settings(): MediaSettings;
  /** What it can run at. */
  capabilities(): MediaDeviceCapabilities;
  /** Runs at other settings, which the page's `applyConstraints` came to:
   *  whether it could. */
  reconfigure(settings: MediaSettings): Promise<boolean>;
  /** Stops it: no frame after it, and no `ended`, since the page ended
   *  it. */
  stop(): void;
  /**
   * A core `MediaStream` that shows it, where the source is one of core's
   * (`coreMediaDevices`): `<Html>` mounts core's `<video srcObject>` and
   * `<audio srcObject>` with it, so a camera goes onto a layer of its own
   * on macOS and its frames never cross into JavaScript, and what an audio
   * element plays is what the echo canceller subtracts. Answers null, or is
   * absent, for a source that is not; `<Html>` shows that one through a
   * `VideoFrames` sink of what `listen` gives.
   */
  present?(): CoreMediaStream | null;
}

/**
 * What a page's media devices are (`HtmlScripts.mediaDevices`). The page's
 * realm decides which device a `getUserMedia` takes and at what settings,
 * and asks `request` before it opens one; what goes wrong rejects with an
 * error named as Media Capture names it (`mediaError`).
 */
export interface HtmlMediaDevices {
  /** The devices there are now. */
  devices(): Promise<MediaDeviceDescription[]>;
  /**
   * Whether a page may have a kind of device without being asked, which
   * decides what `enumerateDevices` shows it and what
   * `navigator.permissions` answers. Absent, `'prompt'` for each.
   */
  permission?(name: 'camera' | 'microphone', origin: string): MediaPermission;
  /**
   * Asks whether the page may have these — the host's prompt, which the
   * page's realm asks only after a gesture where the host wants one.
   * Absent, they are allowed: a host that hands devices has decided.
   */
  request?(ask: MediaPermissionRequest): Promise<boolean>;
  /** Opens a device at the settings the page's constraints came to.
   *  Rejects with `NotFoundError` for a device that is gone, and
   *  `NotReadableError` for one that cannot be opened. */
  open(deviceId: string, settings: MediaSettings): Promise<MediaSourceLike>;
  /**
   * What a `getDisplayMedia` captures: the host's picker, once the page is
   * allowed. Resolves null where the user chose nothing; a source, or a
   * display's picture with its sound where `wants.audio` asked for it and
   * there is any. Absent, a page can capture no display.
   */
  display?(
    ask: MediaPermissionRequest,
    wants?: DisplayWants,
  ): Promise<MediaSourceLike | DisplayCapture | null>;
  /** Tells `changed` whenever the devices change (`devicechange`), until
   *  the function it answers is called. */
  watch?(changed: () => void): () => void;
}

/**
 * A page's source as `<Html>` shows it (`HtmlHandle.showStream`): over a
 * `<video srcObject>` or an `<audio srcObject>` whose stream's first live
 * track of the kind is over it.
 */
export interface ShownSource {
  readonly kind: 'audio' | 'video';
  /** The host's number for it: the same number is the same player. */
  readonly id: number;
  /** Whether the page's track is enabled: one that is not is shown black,
   *  and heard as silence. */
  readonly enabled: boolean;
  /** A core `MediaStream` that shows it, where it is core's
   *  (`MediaSourceLike.present`). */
  present(): CoreMediaStream | null;
  /** Its frames, until the function it answers is called. */
  read(fn: (frame: MediaVideoFrame | MediaAudioData) => void): () => void;
  /** What it runs at now. */
  settings(): MediaSettings;
}

/** What a media element playing a `MediaStream` shows and plays: its
 *  first live video track's source, and its first live audio track's. */
export interface StreamShown {
  video: ShownSource | null;
  audio: ShownSource | null;
}

/** What a page's `getDisplayMedia` prefers (Screen Capture 5.4): the
 *  kind of surface it would rather have offered first, the pointer, and
 *  whether it would have the sound too. A picker is free to offer other. */
export interface DisplayWants {
  displaySurface?: 'monitor' | 'window' | 'browser';
  /** `monitorTypeSurfaces: 'exclude'`: not a whole screen. */
  monitors: boolean;
  cursor?: 'always' | 'motion' | 'never';
  audio: boolean;
}

/** What a display capture comes to: its picture, and its sound where
 *  there is any. */
export interface DisplayCapture {
  video: MediaSourceLike;
  audio?: MediaSourceLike | null;
}

/** The names a media seam rejects with, as Media Capture and Streams has
 *  them. */
export type MediaErrorName =
  | 'AbortError'
  | 'NotAllowedError'
  | 'NotFoundError'
  | 'NotReadableError'
  | 'OverconstrainedError';

/** An error a media seam rejects with, its `name` the one the page's
 *  `DOMException` takes — and an `OverconstrainedError`'s `constraint`. */
export function mediaError(
  name: MediaErrorName,
  message: string,
  constraint?: string,
): Error & { name: MediaErrorName; constraint?: string } {
  const error = new Error(message) as Error & {
    name: MediaErrorName;
    constraint?: string;
  };
  error.name = name;
  if (constraint !== undefined) error.constraint = constraint;
  return error;
}

/**
 * A source that gives nothing, muted from the start: a stand-in for a
 * remote track no media has reached, and the receiver's track of a
 * connection no stack carries.
 */
export function idleSource(
  kind: 'audio' | 'video',
  label = '',
): MediaSourceLike {
  let stopped = false;
  return {
    kind,
    label,
    listen(events) {
      if (!stopped) events.muted(true);
    },
    settings: () => ({}),
    capabilities: () => ({}),
    reconfigure: () => Promise.resolve(false),
    stop() {
      stopped = true;
    },
  };
}

/**
 * The default `mediaDevices`: none, as on a machine with no camera and no
 * microphone — a page lists nothing, and a `getUserMedia` rejects with a
 * `NotFoundError`.
 */
export const NO_MEDIA_DEVICES: HtmlMediaDevices = {
  devices: () => Promise.resolve([]),
  permission: () => 'denied',
  open: (deviceId) =>
    Promise.reject(
      mediaError(
        'NotFoundError',
        `${deviceId} was not opened: this <Html> has no scripts.mediaDevices.`,
      ),
    ),
};
