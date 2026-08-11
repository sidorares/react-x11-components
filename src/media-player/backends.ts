// Two players, one table — the media-player half of what `../terminal/
// backends.ts` does for emulators.
//
// A backend is an argv builder plus a way to open its control channel. Both
// halves belong together because they agree on one thing the component never
// sees: the socket path is passed on the command line and connected to
// afterwards, and the flag that names it is different in each player.
//
// The argv builders are pure and synchronous, so `test/media-player.test.ts`
// asserts every flag without mpv or VLC installed anywhere.
import type { ProcessHost } from '../embed/index.js';
import type { PlayerControl, PlayerEvents } from './control.js';
import { connectMpv } from './mpv.js';
import { connectVlc } from './vlc.js';

/** Which player to embed. `'auto'` takes the first one installed. */
export type MediaBackendName = 'auto' | 'mpv' | 'vlc';

/** Everything the argv builders read. */
export interface MediaLaunch {
  /** The `<foreign>` container to draw into. */
  windowId: number;
  /** A path or a URL. Omitted starts the player idle. */
  src?: string;
  /** Where the player should create its control socket. */
  controlPath: string;
  autoPlay?: boolean;
  /** 0–1. */
  volume?: number;
  muted?: boolean;
  /** `'16:9'`, `'4:3'` — the player letterboxes inside the element's rect. */
  aspectRatio?: string;
  loop?: boolean;
  /** The player's *own* on-screen controls. Off by default: they are the one
   *  part of the surface that will not match the app around it. */
  osd?: boolean;
  /** Appended verbatim, before the source. The escape hatch for the long
   *  tail of player options this package will never wrap. */
  extraArgs?: readonly string[];
}

export interface MediaBackend {
  name: Exclude<MediaBackendName, 'auto'>;
  binaries: readonly string[];
  /** Whether `onProgress` can fire under this backend. */
  reportsProgress: boolean;
  args(launch: MediaLaunch): string[];
  connect(
    host: ProcessHost,
    controlPath: string,
    events: PlayerEvents,
    launch: MediaLaunch,
  ): Promise<PlayerControl>;
}

/**
 * mpv.
 *
 * `--wid` is plain reparenting — mpv sets no `_XEMBED_INFO` — which is
 * exactly the case `<foreign>`'s adopt path handles. `--idle=yes` keeps the
 * process alive with nothing loaded, so a player with no `src` yet is still a
 * window that can be given one later, and `--no-terminal` keeps it off a
 * stdio it was never given.
 */
export const mpv: MediaBackend = {
  name: 'mpv',
  binaries: ['mpv'],
  reportsProgress: true,
  args(launch) {
    const args = [
      `--wid=${launch.windowId}`,
      `--input-ipc-server=${launch.controlPath}`,
      '--idle=yes',
      '--no-terminal',
    ];
    // The on-screen controller is mpv's own chrome. Off unless asked for,
    // because it is drawn by mpv and cannot follow the app's theme.
    args.push(launch.osd ? '--osc=yes' : '--no-osc');
    if (launch.autoPlay === false) args.push('--pause=yes');
    if (launch.volume != null) {
      args.push(`--volume=${Math.round(clampUnit(launch.volume) * 100)}`);
    }
    if (launch.muted) args.push('--mute=yes');
    if (launch.aspectRatio) {
      args.push(`--video-aspect-override=${launch.aspectRatio}`);
    }
    if (launch.loop) args.push('--loop-file=inf');
    if (launch.extraArgs?.length) args.push(...launch.extraArgs);
    // `--` so a file called `--version` is a file.
    if (launch.src) args.push('--', launch.src);
    return args;
  },
  connect(host, controlPath, events) {
    return connectMpv(host, controlPath, events);
  },
};

/**
 * VLC.
 *
 * `--drawable-xid` is the X11 video output's embed option. `--intf dummy`
 * suppresses the full interface — the video output still creates its window,
 * which is the one being embedded — and `--extraintf rc` adds the control
 * socket. See `./vlc.ts` for why that socket is written to and not read.
 */
export const vlc: MediaBackend = {
  name: 'vlc',
  binaries: ['vlc'],
  reportsProgress: false,
  args(launch) {
    const args = [
      `--drawable-xid=${launch.windowId}`,
      '--intf',
      'dummy',
      '--extraintf',
      'rc',
      `--rc-unix=${launch.controlPath}`,
      '--no-video-title-show',
    ];
    if (!launch.osd) args.push('--no-osd');
    if (launch.autoPlay === false) args.push('--start-paused');
    if (launch.aspectRatio) args.push(`--aspect-ratio=${launch.aspectRatio}`);
    if (launch.loop) args.push('--loop');
    if (launch.extraArgs?.length) args.push(...launch.extraArgs);
    if (launch.src) args.push('--', launch.src);
    return args;
  },
  connect(host, controlPath, events, launch) {
    return connectVlc(host, controlPath, events, {
      paused: launch.autoPlay === false,
    });
  },
};

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * Auto-detection order.
 *
 * mpv first, and not only because it is lighter: it is the one whose control
 * channel reports position back, so `onProgress` works on a machine that has
 * both. An app that would rather have VLC says `backend="vlc"`.
 */
export const MEDIA_BACKENDS: readonly MediaBackend[] = [mpv, vlc];

/** The backends a `backend` prop selects. `'auto'` is all of them, in order. */
export function mediaBackendsFor(
  name: MediaBackendName,
): readonly MediaBackend[] {
  if (name === 'auto') return MEDIA_BACKENDS;
  return MEDIA_BACKENDS.filter((b) => b.name === name);
}
