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
  echoCancellation?: boolean[];
  autoGainControl?: boolean[];
  noiseSuppression?: boolean[];
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
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  noiseSuppression?: boolean;
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
 * One frame of video, as I420: a Y plane, then Cb and Cr at half the size
 * each way — `yuv420p`, what core's `VideoFrames` takes as `'I420'` and what
 * libvpx encodes from.
 */
export interface MediaVideoFrame {
  width: number;
  height: number;
  /** Y, Cb, Cr. Read until the next frame and not after it: what keeps a
   *  frame copies it. */
  planes: [Uint8Array, Uint8Array, Uint8Array];
  /** Each plane's bytes per row. */
  strides: [number, number, number];
  /** When it was captured, in microseconds on the source's clock, as
   *  WebCodecs' `timestamp`. */
  timestamp: number;
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
  /** A frame, where it is a video source. */
  video?(frame: MediaVideoFrame): void;
  /** A chunk, where it is an audio source. */
  audio?(data: MediaAudioData): void;
  /**
   * It gives no frames for now, or gives them again: a track's `mute` and
   * `unmute`. A remote peer's source is muted until its media arrives.
   */
  muted(muted: boolean): void;
  /** It will give no more — unplugged, taken back, the peer's track gone —
   *  and the tracks of it end. Told once, and nothing after it. */
  ended(): void;
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
  /** Starts telling its events, to one listener: the host hands each frame
   *  on to whatever reads it. */
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
   * allowed. Resolves null where the user chose nothing. Absent, a page
   * can capture no display.
   */
  display?(ask: MediaPermissionRequest): Promise<MediaSourceLike | null>;
  /** Tells `changed` whenever the devices change (`devicechange`), until
   *  the function it answers is called. */
  watch?(changed: () => void): () => void;
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
