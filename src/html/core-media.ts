// The real cameras, microphones and screens, behind the `HtmlMediaDevices`
// seam (`./media-devices.ts`): react-x11's media capture (its
// docs/media.md) — `enumerateDevices`, `watchDevices`, `getUserMedia` and
// `getDisplayMedia` — as a page's `navigator.mediaDevices` reaches them.
// What a host hands as `HtmlScripts.mediaDevices` where it wants a page to
// have the machine's devices; `<Html>` imports none of it.
//
// Two things here are decisions:
//
// - **A device a page opens is one core track**, opened at the settings
//   the page's constraints came to (`getUserMedia({ [kind]: { deviceId:
//   { exact }, ...settings } })`, each setting an `ideal`), and the source
//   the page's tracks are over is that track. Core shares a device opened
//   at one setting between everything that asks for it, so a page's preview
//   and a call screen beside it are one capture session.
// - **A source is core's to show** (`present`): `<Html>` mounts core's
//   `<video srcObject>` and `<audio srcObject>` with a core `MediaStream` of
//   the track, so a camera goes onto a layer of its own on macOS without a
//   frame crossing into JavaScript, and what a page plays through an
//   `<audio>` is what the echo canceller subtracts. Frames are read off the
//   track (`onFrame`) only while something of the page's reads them.
//
// Core lists a device's capabilities and no settings it runs at by default,
// so what a track runs at where a page's constraints leave a setting open
// is Chrome's: 640×480 at 30 frames a second, and 48 kHz mono with echo
// cancellation, noise suppression and automatic gain on, each held to what
// the device can do. Core's times are seconds; the seam's are
// microseconds.

import {
  enumerateDevices,
  getDisplayMedia,
  getUserMedia,
  MediaStream,
  watchDevices,
} from 'react-x11';
import type {
  MediaDeviceInfo,
  MediaStreamTrack,
  MediaTrackCapabilities,
  MediaTrackSettings,
} from 'react-x11';

import { mediaError } from './media-devices.js';
import type {
  DisplayWants,
  HtmlMediaDevices,
  MediaDeviceCapabilities,
  MediaDeviceDescription,
  MediaMode,
  MediaPermission,
  MediaPermissionRequest,
  MediaSettings,
  MediaSourceEvents,
  MediaSourceLike,
} from './media-devices.js';

/** What `coreMediaDevices` is handed besides the app. */
export interface CoreMediaOptions {
  /**
   * Where a page stands for a kind of device without being asked, which
   * decides what `enumerateDevices` shows it — the host's own record of
   * what each origin was allowed. Absent, `'prompt'`: core asks the system
   * as a device opens, and the page is not asked by anyone else.
   */
  permission?(name: 'camera' | 'microphone', origin: string): MediaPermission;
  /** Asks the user whether a page may have these, before anything opens:
   *  the host's prompt. Absent, a page that asks is let have them. */
  request?(ask: MediaPermissionRequest): Promise<boolean>;
}

const VIDEO_DEFAULTS = { width: 640, height: 480, frameRate: 30 };
const AUDIO_DEFAULTS = {
  sampleRate: 48000,
  sampleSize: 16,
  channelCount: 1,
  latency: 0.01,
};

const clamp = (value: number, range?: { min: number; max: number }) =>
  range ? Math.min(range.max, Math.max(range.min, value)) : value;

/** A boolean setting a device can take, the default where it can: the
 *  first boolean it lists where it cannot. */
const choose = (
  wanted: boolean,
  can?: readonly unknown[],
): boolean | undefined => {
  const booleans = (can ?? []).filter(
    (v): v is boolean => typeof v === 'boolean',
  );
  return !booleans.length
    ? undefined
    : booleans.includes(wanted)
      ? wanted
      : booleans[0];
};

/** What a track of a device runs at where a page asks nothing: Chrome's,
 *  held to the device. */
export function coreDefaults(device: {
  kind: string;
  capabilities: MediaDeviceCapabilities;
}): MediaSettings {
  const caps = device.capabilities;
  if (device.kind === 'videoinput') {
    const width = clamp(VIDEO_DEFAULTS.width, caps.width);
    const height = clamp(VIDEO_DEFAULTS.height, caps.height);
    return {
      width,
      height,
      aspectRatio: width / height,
      frameRate: clamp(VIDEO_DEFAULTS.frameRate, caps.frameRate),
      resizeMode: caps.resizeMode?.includes('none')
        ? 'none'
        : caps.resizeMode?.[0],
      ...(caps.facingMode?.length && { facingMode: caps.facingMode[0] }),
    };
  }
  if (device.kind === 'audioinput') {
    const out: MediaSettings = {
      sampleRate: clamp(AUDIO_DEFAULTS.sampleRate, caps.sampleRate),
      sampleSize: clamp(AUDIO_DEFAULTS.sampleSize, caps.sampleSize),
      channelCount: clamp(AUDIO_DEFAULTS.channelCount, caps.channelCount),
      latency: clamp(AUDIO_DEFAULTS.latency, caps.latency),
    };
    for (const name of [
      'echoCancellation',
      'autoGainControl',
      'noiseSuppression',
    ] as const) {
      const v = choose(true, caps[name]);
      if (v !== undefined) out[name] = v;
    }
    return out;
  }
  return {};
}

/** A core device as the seam describes one. A camera's modes are its
 *  default and its largest, since core lists ranges and not the sizes in
 *  them: a page asks for a size between, and core gives the nearest. */
function describe(d: MediaDeviceInfo): MediaDeviceDescription {
  const capabilities = capabilitiesOf(d.capabilities);
  const defaults = coreDefaults({ kind: d.kind, capabilities });
  const { width, height, frameRate } = capabilities;
  const modes: MediaMode[] = [];
  if (d.kind === 'videoinput' && width && height) {
    modes.push({
      width: defaults.width!,
      height: defaults.height!,
      frameRate: defaults.frameRate ?? 30,
    });
    if (width.max !== defaults.width || height.max !== defaults.height) {
      modes.push({
        width: width.max,
        height: height.max,
        frameRate: frameRate?.max ?? defaults.frameRate ?? 30,
      });
    }
  }
  return {
    deviceId: d.deviceId,
    // a device the platform says nothing of shares no group: its own id
    groupId: d.groupId || d.deviceId,
    kind: d.kind as MediaDeviceDescription['kind'],
    label: d.label,
    capabilities,
    defaults,
    ...(modes.length && { modes }),
  };
}

/** Core's capabilities, less the ids the page's realm digests itself. */
function capabilitiesOf(caps: MediaTrackCapabilities): MediaDeviceCapabilities {
  const { deviceId: _id, groupId: _group, ...rest } = caps;
  return rest;
}

/** Core's settings, less the ids. */
function settingsOf(settings: MediaTrackSettings): MediaSettings {
  const { deviceId: _id, groupId: _group, ...rest } = settings;
  return rest;
}

const VIDEO_SETTINGS = [
  'width',
  'height',
  'aspectRatio',
  'frameRate',
  'facingMode',
  'resizeMode',
] as const;
const AUDIO_SETTINGS = [
  'sampleRate',
  'sampleSize',
  'channelCount',
  'latency',
  'echoCancellation',
  'autoGainControl',
  'noiseSuppression',
] as const;

/** The constraints a core `getUserMedia` or `applyConstraints` is handed
 *  for settings the page's realm chose: each an `ideal`, which core fits
 *  to the device as nearly as it can. */
function idealsOf(
  kind: 'audio' | 'video',
  settings: MediaSettings,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of kind === 'video' ? VIDEO_SETTINGS : AUDIO_SETTINGS) {
    const v = settings[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * A core track as a seam's source. Its frames are read off it only while
 * the listener reads them, its muted state and its end told as `onChange`
 * says, and it shows itself through a core `MediaStream` of it.
 */
export function coreTrackSource(
  track: MediaStreamTrack,
  extra: MediaSettings = {},
): MediaSourceLike {
  let events: MediaSourceEvents | null = null;
  let offFrame: (() => void) | null = null;
  let offChange: (() => void) | null = null;
  let muted = track.muted;
  let ended = false;
  let stopped = false;
  let shown: MediaStream | null = null;
  let last = '';
  const kind = track.kind;

  const changed = () => {
    if (!events || stopped || ended) return;
    if (track.readyState === 'ended') {
      ended = true;
      offFrame?.();
      offFrame = null;
      events.ended();
      return;
    }
    if (track.muted !== muted) {
      muted = track.muted;
      events.muted(muted);
    }
    // settings that moved: a camera at another size, a screen at another
    const now = JSON.stringify(track.getSettings());
    if (now !== last) {
      last = now;
      events.changed?.();
    }
  };

  return {
    kind,
    label: track.label,
    listen(next) {
      events = next;
      if (stopped || ended) return;
      if (!offChange) {
        last = JSON.stringify(track.getSettings());
        offChange = track.onChange(changed);
      }
      next.muted(track.muted);
      const reads = kind === 'video' ? !!next.video : !!next.audio;
      if (reads && !offFrame) {
        offFrame = track.onFrame((frame) => {
          const to = events;
          if (!to) return;
          const time = Math.round(frame.time * 1e6);
          if (kind === 'video') {
            to.video?.({
              format: frame.format,
              width: frame.width,
              height: frame.height,
              planes: frame.planes,
              strides: frame.strides,
              colorSpace: frame.colorSpace,
              range: frame.range,
              timestamp: time,
            });
          } else {
            to.audio?.({
              sampleRate: frame.sampleRate,
              channels: frame.channels,
              frames: frame.frames,
              timestamp: time,
            });
          }
        });
      } else if (!reads && offFrame) {
        offFrame();
        offFrame = null;
      }
    },
    settings: () => ({ ...extra, ...settingsOf(track.getSettings()) }),
    capabilities: () => capabilitiesOf(track.getCapabilities()),
    async reconfigure(settings) {
      try {
        await track.applyConstraints(idealsOf(kind, settings));
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      offFrame?.();
      offChange?.();
      offFrame = offChange = null;
      events = null;
      track.stop();
    },
    present() {
      if (stopped || ended) return null;
      return (shown ??= new MediaStream([track]));
    },
  };
}

/** What a core rejection crosses to the page as: its name kept, which is
 *  a browser's (`NotAllowedError`, `NotReadableError`, …). */
function rethrown(error: unknown): Error {
  const e = error as { name?: unknown; message?: unknown };
  if (e && typeof e.name === 'string' && typeof e.message === 'string') {
    return error as Error;
  }
  return mediaError('AbortError', String(error));
}

/**
 * A page's media devices over react-x11's media capture: the machine's
 * cameras, microphones and speakers, and its screen. On macOS that is
 * AVFoundation's cameras, CoreAudio's microphones (echo cancelled) and
 * outputs; on X11 the screen alone, since core has no camera or microphone
 * there yet, so a page there lists none.
 *
 * In a `<Frame>` pane on macOS core captures nothing — a pane runs no
 * AppKit — so a host that runs its pages in panes hands these only where
 * its pages run in its own window.
 */
export function coreMediaDevices(
  app: unknown,
  options: CoreMediaOptions = {},
): HtmlMediaDevices {
  const listed = async (): Promise<MediaDeviceInfo[]> =>
    (await enumerateDevices({ app })).filter((d) => d.kind !== 'systemaudio');
  return {
    devices: async () => (await listed()).map(describe),
    ...(options.permission && { permission: options.permission }),
    ...(options.request && { request: options.request }),
    async open(deviceId, settings) {
      const device = (await listed()).find((d) => d.deviceId === deviceId);
      if (!device || device.kind === 'audiooutput') {
        throw mediaError('NotFoundError', `There is no ${deviceId}.`);
      }
      const kind = device.kind === 'videoinput' ? 'video' : 'audio';
      let stream: MediaStream;
      try {
        stream = await getUserMedia(
          {
            [kind]: {
              ...idealsOf(kind, settings),
              deviceId: { exact: deviceId },
            },
          },
          { app },
        );
      } catch (error) {
        throw rethrown(error);
      }
      const track =
        kind === 'video'
          ? stream.getVideoTracks()[0]
          : stream.getAudioTracks()[0];
      if (!track)
        throw mediaError('NotReadableError', `${deviceId} gave no track.`);
      return coreTrackSource(track);
    },
    async display(_ask, wants?: DisplayWants) {
      let stream: MediaStream;
      try {
        stream = await getDisplayMedia(
          { video: true, audio: wants?.audio ? 'system' : false },
          { app },
        );
      } catch (error) {
        throw rethrown(error);
      }
      const [video] = stream.getVideoTracks();
      const [audio] = stream.getAudioTracks();
      if (!video) {
        for (const t of stream.getTracks()) t.stop();
        return null;
      }
      const at = video.getSettings();
      return {
        video: coreTrackSource(video, {
          displaySurface: at.displaySurface ?? 'monitor',
          logicalSurface: true,
          cursor: at.cursor ?? 'never',
        }),
        audio: audio ? coreTrackSource(audio) : null,
      };
    },
    watch: (changed) => watchDevices(changed, { app }),
  };
}
