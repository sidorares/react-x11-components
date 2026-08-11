// <MediaPlayer> — mpv or VLC, drawing into an element.
//
// The second XEmbed wrapper, and mechanically the same component as
// `../terminal/`: a `<foreign>` with no `windowId` adopts whatever is put
// inside it, the id `onReady` hands over is passed to the player as
// `--wid=…`, and `../embed/` owns everything about starting, watching and
// handing back the process.
//
// What makes it more than a surface is the control channel. mpv's JSON IPC
// socket turns `volume`, `paused` and `seek()` into real commands and pushes
// position back as it changes, so `src` can be swapped inside a running
// player rather than by respawning one. `./backends.ts` is where that and
// VLC's much narrower rc interface are reconciled.
//
// Registers no element: `<foreign>` is a built-in. Nothing here happens at
// import time.
//
// ### Controls
//
// There are none drawn, on purpose. The player's window stacks above
// everything drawn in ours — the same rule `<glarea>` has — so a transport bar
// laid over the video cannot be a sibling `<box>`; it has to be a `<popup>`,
// which is a placement and dismissal problem an app is better placed to solve
// than a component is. What this exposes instead is the whole of the state a
// transport bar needs (`onProgress`, `onPlayingChange`, the handle) plus
// `osd` for the player's own overlay when a quick one will do.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { useTheme } from 'react-x11';
import type { ForeignProps } from 'react-x11';
import type { Style } from 'react-x11/style';

import {
  BackendUnavailableError,
  resolveBackend,
  useEmbeddedClient,
} from '../embed/index.js';
import type {
  EmbedStatus,
  ExitInfo,
  LaunchPlan,
  PlanContext,
  ProcessHost,
} from '../embed/index.js';
import { mediaBackendsFor } from './backends.js';
import type { MediaBackendName, MediaLaunch } from './backends.js';
import type { PlayerControl } from './control.js';
import { hx } from './hx.js';

export { MEDIA_BACKENDS, mediaBackendsFor, mpv, vlc } from './backends.js';
export type {
  MediaBackend,
  MediaBackendName,
  MediaLaunch,
} from './backends.js';
export type { PlayerControl, PlayerEvents } from './control.js';

const h = React.createElement;

/** `<foreign>`'s props as `hx` takes them. */
type ForeignElementProps = Omit<ForeignProps, 'theme'>;

/** Where playback is. */
export interface MediaProgress {
  /** Seconds from the start. */
  position: number;
  /** Seconds, or 0 before the player knows. */
  duration: number;
}

/** What a `ref` on `<MediaPlayer>` gets. */
export interface MediaPlayerHandle {
  play(): void;
  pause(): void;
  /** Absolute position, in seconds. */
  seek(seconds: number): void;
  /** 0–1. */
  setVolume(volume: number): void;
  /** Stop playback without stopping the player: the window stays, idle. */
  stop(): void;
  /** Stop the player process and start a new one. */
  restart(): void;
  signal(signal?: string): boolean;
  readonly pid: number | null;
  readonly windowId: number | null;
  readonly backend: string | null;
  readonly status: EmbedStatus;
  /** False under VLC — see `./vlc.ts`. `onProgress` never fires then. */
  readonly reportsProgress: boolean;
}

export interface MediaPlayerProps {
  /**
   * A path or a URL. **Changing it does not restart the player** — the new
   * source is loaded into the running one, so the window never blinks.
   */
  src?: string;
  /** Which player. Default `'auto'`: mpv if it is installed, else VLC. */
  backend?: MediaBackendName;
  /** Start playing. Default true. */
  autoPlay?: boolean;
  /**
   * Pause state, if you want to drive it. Leave it out and the player is
   * uncontrolled — `autoPlay` decides how it starts and the handle's
   * `play()`/`pause()` move it from there.
   */
  paused?: boolean;
  /** 0–1. Default: the player's own. */
  volume?: number;
  muted?: boolean;
  /** `'16:9'`, `'4:3'`. The player letterboxes inside the element's rect. */
  aspectRatio?: string;
  loop?: boolean;
  /** The player's own on-screen controls. Off by default: they are drawn by
   *  the player and will not match the app's theme. */
  osd?: boolean;
  /** Appended to the player's command line verbatim. */
  extraArgs?: readonly string[];
  /** Position and duration, as the player reports them. mpv only. */
  onProgress?: (progress: MediaProgress) => void;
  /** The file reached its end. Not fired for `stop()` or a new `src`. */
  onEnded?: (info: { node: unknown }) => void;
  onPlayingChange?: (playing: boolean) => void;
  /** The player process ended. */
  onExit?: (info: ExitInfo) => void;
  /** Spawn failures, control-channel failures, and the
   *  `BackendUnavailableError` for a machine with neither player installed. */
  onError?: (err: Error) => void;
  /** Rendered instead of the surface when no backend is installed. */
  fallback?: ReactNode;
  /** False holds off spawning entirely. */
  enabled?: boolean;
  /** Sent on unmount and restart. Default `SIGTERM`. */
  stopSignal?: string;
  /** Where the process runs. Defaults to this machine, through node. */
  processes?: ProcessHost;
  /** A video surface is not a control; default false, unlike `<Terminal>`. */
  focusable?: boolean;
  style?: Style | Style[];
  ref?: Ref<MediaPlayerHandle>;
  'data-testname'?: string;
}

/**
 * A video surface.
 *
 * ```jsx
 * <MediaPlayer
 *   src={file}
 *   aspectRatio="16:9"
 *   volume={0.8}
 *   style={{ flexGrow: 1 }}
 *   onProgress={({ position, duration }) => setScrub(position / duration)}
 *   onEnded={next}
 *   fallback={<text>Install mpv to play video.</text>}
 * />
 * ```
 *
 * The player's window stacks above everything drawn in this one, so nothing 2D
 * can overlap it — see "Controls" at the top of this file.
 */
export function MediaPlayer(props: MediaPlayerProps): ReactElement {
  const {
    backend = 'auto',
    enabled = true,
    focusable,
    processes,
    stopSignal,
  } = props;
  const theme = useTheme() as unknown as Record<string, unknown>;

  const control = useRef<PlayerControl | null>(null);
  // Bumped when a control channel opens or closes. The prop-syncing effects
  // below depend on it, which is what makes "apply `volume` once there is
  // something to apply it to" a dependency rather than a retry.
  const [channel, setChannel] = useState(0);
  // What the player was launched with, so a `src` that has not changed is not
  // loaded a second time over the top of itself.
  const loaded = useRef<string | undefined>(undefined);

  // Read through a ref so that the plan's identity — which is the restart
  // signal — depends only on the launch key below.
  const latest = useRef(props);
  latest.current = props;

  // Only the props that cannot be changed in a running player. `src`,
  // `volume`, `muted` and `paused` are all live commands, so they are
  // deliberately absent: including them would respawn the process for a
  // volume slider.
  const key = useMemo(
    () =>
      JSON.stringify([
        backend,
        props.aspectRatio ?? null,
        props.loop ?? false,
        props.osd ?? false,
        props.extraArgs ?? null,
      ]),
    [backend, props.aspectRatio, props.loop, props.osd, props.extraArgs],
  );

  const plan = useMemo(
    () =>
      async ({ windowId, host }: PlanContext): Promise<LaunchPlan> => {
        const candidates = mediaBackendsFor(backend);
        if (candidates.length === 0) {
          throw new BackendUnavailableError('media player', [backend]);
        }
        const chosen = await resolveBackend(host, 'media player', candidates);
        const scratch = await host.socketPath(
          `react-x11-${chosen.backend.name}`,
        );
        const current = latest.current;
        const launch: MediaLaunch = {
          windowId,
          controlPath: scratch.path,
          src: current.src,
          autoPlay: current.autoPlay ?? true,
          volume: current.volume,
          muted: current.muted,
          aspectRatio: current.aspectRatio,
          loop: current.loop,
          osd: current.osd,
          extraArgs: current.extraArgs,
        };

        return {
          command: chosen.path,
          args: chosen.backend.args(launch),
          backend: chosen.backend.name,
          async attach() {
            const events = {
              onProgress: (progress: MediaProgress) =>
                latest.current.onProgress?.(progress),
              onPlayingChange: (playing: boolean) =>
                latest.current.onPlayingChange?.(playing),
              onEnded: () => latest.current.onEnded?.({ node: null }),
              onError: (err: Error) => latest.current.onError?.(err),
            };
            const opened = await chosen.backend.connect(
              host,
              scratch.path,
              events,
              launch,
            );
            control.current = opened;
            loaded.current = launch.src;
            setChannel((n) => n + 1);
            return () => {
              control.current = null;
              loaded.current = undefined;
              opened.dispose();
              setChannel((n) => n + 1);
            };
          },
          dispose: () => scratch.dispose(),
        };
      },
    [backend, key],
  );

  const client = useEmbeddedClient({
    plan,
    host: processes,
    enabled,
    stopSignal,
    onExit: props.onExit,
    onError: props.onError,
  });

  // --- props the control channel applies to a running player ---------------

  const { src, volume, muted, paused } = props;

  useEffect(() => {
    if (!control.current || src === undefined) return;
    if (src === loaded.current) return;
    loaded.current = src;
    control.current.load(src);
  }, [src, channel]);

  useEffect(() => {
    if (!control.current || volume === undefined) return;
    control.current.setVolume(volume);
  }, [volume, channel]);

  useEffect(() => {
    if (!control.current || muted === undefined) return;
    control.current.setMuted(muted);
  }, [muted, channel]);

  useEffect(() => {
    if (!control.current || paused === undefined) return;
    control.current.setPaused(paused);
  }, [paused, channel]);

  // --- the handle ---------------------------------------------------------

  const reportsProgress = useMemo(() => {
    const [chosen] = mediaBackendsFor(backend).filter(
      (b) => b.name === client.backend,
    );
    return chosen?.reportsProgress ?? false;
  }, [backend, client.backend]);

  const noop = useCallback(() => {}, []);

  React.useImperativeHandle(
    props.ref,
    () => ({
      play: () => control.current?.setPaused(false) ?? noop(),
      pause: () => control.current?.setPaused(true) ?? noop(),
      seek: (seconds: number) => control.current?.seek(seconds) ?? noop(),
      setVolume: (value: number) => control.current?.setVolume(value) ?? noop(),
      stop: () => control.current?.stop() ?? noop(),
      restart: client.restart,
      signal: client.signal,
      get pid() {
        return client.pid;
      },
      get windowId() {
        return client.windowId;
      },
      get backend() {
        return client.backend;
      },
      get status() {
        return client.status;
      },
      get reportsProgress() {
        return reportsProgress;
      },
    }),
    [client, noop, reportsProgress],
  );

  // Black rather than the theme background: this is a video surface, and what
  // shows around a letterboxed frame should be what a player would put there.
  const style: Style = {
    flexGrow: 1,
    backgroundColor: String(theme.videoBackground ?? '#000000'),
  };
  const styles: Style[] = [style];
  if (props.style) {
    for (const extra of Array.isArray(props.style)
      ? props.style
      : [props.style]) {
      styles.push(extra);
    }
  }

  if (client.status === 'unavailable' && props.fallback !== undefined) {
    return h(React.Fragment, null, props.fallback);
  }

  const foreign: ForeignElementProps = {
    onReady: client.handleReady,
    // A video surface is not something to tab to, and an embedded player that
    // took the focus would swallow the app's own keys while the pointer is
    // over it.
    focusable: focusable ?? false,
    'aria-label': 'Media player',
    style: styles,
  };

  // See the same note in `../terminal/index.ts`: `data-testname` is a runtime
  // convention react-x11's element declarations do not carry.
  return hx('foreign', {
    ...foreign,
    'data-testname': props['data-testname'],
  } as ForeignElementProps);
}
