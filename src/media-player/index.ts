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
// Registers no element: `<foreign>` and `<video>` are built-ins. Nothing here
// happens at import time.
//
// ### The third backend, which is not a window
//
// `backend="ffmpeg"` (`./ffmpeg.ts`, `./frames.ts`) decodes the file in an
// ffmpeg child process and pushes each frame into a core `<video frames>`
// sink — so it needs no XEmbed, runs on every react-x11 backend, and is a
// drawn node in the paint order rather than a window over it. It is silent.
// `'auto'` reaches it where nothing can be embedded (Wayland, macOS) and on
// an X11 desktop with neither player, and `MediaPlayer` below is only the
// choice between the two paths: `EmbeddedPlayer` and `FramesPlayer`.
//
// ### Controls
//
// There are none drawn, on purpose. An embedded player's window stacks above
// everything drawn in ours — the same rule `<glarea>` has — so a transport
// bar laid over the video cannot be a sibling `<box>`; it has to be a
// `<popup>`, which is a placement and dismissal problem an app is better
// placed to solve than a component is. What this exposes instead is the
// whole of the state a transport bar needs (`onProgress`, `onPlayingChange`,
// the handle) plus `osd` for the player's own overlay when a quick one will
// do. Under ffmpeg the bar *can* be a sibling laid over the picture, and it
// is still the app's to draw.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { useApp, useTheme } from 'react-x11';
import type { ForeignProps } from 'react-x11';
import type { Style } from 'react-x11/style';

import {
  BackendUnavailableError,
  canHostXEmbed,
  nodeProcessHost,
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
import { MEDIA_BACKENDS, mediaBackendsFor } from './backends.js';
import type { MediaBackendName, MediaLaunch } from './backends.js';
import type { PlayerControl } from './control.js';
import { FramesPlayer } from './frames.js';
import { hx } from './hx.js';
import { surfaceStyles } from './surface.js';

export {
  MEDIA_BACKENDS,
  ffmpeg,
  mediaBackendsFor,
  mpv,
  vlc,
} from './backends.js';
export type {
  MediaBackend,
  MediaBackendName,
  MediaLaunch,
} from './backends.js';
export type { PlayerControl, PlayerEvents } from './control.js';
export { MediaProbeError } from './ffmpeg.js';

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
  /** Stop playback without stopping the player: the window stays, idle.
   *  Under ffmpeg the picture goes, and `play()` starts from the top. */
  stop(): void;
  /** Stop the player process and start a new one. */
  restart(): void;
  /** Under ffmpeg, the decoder running now — there is one per seek. */
  signal(signal?: string): boolean;
  readonly pid: number | null;
  /** The embedded player's container. Null under ffmpeg, which has none. */
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
   * Under ffmpeg the old clip plays on until the new one has been probed.
   */
  src?: string;
  /**
   * Which player. Default `'auto'`: mpv if it is installed, else VLC — where
   * this app can embed a window — and else ffmpeg, decoding into a
   * `<video frames>` sink. On a backend that cannot embed (Wayland, macOS),
   * `'auto'` is ffmpeg alone.
   */
  backend?: MediaBackendName;
  /** Start playing. Default true. */
  autoPlay?: boolean;
  /**
   * Pause state, if you want to drive it. Leave it out and the player is
   * uncontrolled — `autoPlay` decides how it starts and the handle's
   * `play()`/`pause()` move it from there.
   */
  paused?: boolean;
  /** 0–1. Default: the player's own. Nothing under ffmpeg, which is
   *  silent. */
  volume?: number;
  /** Nothing under ffmpeg, which is silent. */
  muted?: boolean;
  /** `'16:9'`, `'4:3'`. The player letterboxes inside the element's rect. */
  aspectRatio?: string;
  loop?: boolean;
  /** The player's own on-screen controls. Off by default: they are drawn by
   *  the player and will not match the app's theme. ffmpeg has none. */
  osd?: boolean;
  /** Appended to the player's command line verbatim. Under ffmpeg they are
   *  input options, before `-i`: `['-hwaccel', 'vaapi']`. */
  extraArgs?: readonly string[];
  /** Position and duration, as the player reports them. mpv and ffmpeg —
   *  never VLC; see `reportsProgress`. */
  onProgress?: (progress: MediaProgress) => void;
  /** The file reached its end. Not fired for `stop()` or a new `src`. */
  onEnded?: (info: { node: unknown }) => void;
  onPlayingChange?: (playing: boolean) => void;
  /** The player process ended. */
  onExit?: (info: ExitInfo) => void;
  /** Spawn failures, control-channel failures, the `BackendUnavailableError`
   *  for a machine with no player installed, the `EmbedUnsupportedError`
   *  for `backend="mpv"` or `"vlc"` on a react-x11 backend that cannot embed
   *  a window at all, and under ffmpeg a `MediaProbeError` for a file it
   *  cannot read. */
  onError?: (err: Error) => void;
  /** Rendered instead of the surface when no player is available — none
   *  installed, or none that can run on this react-x11 backend. */
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
 * An embedded player's window stacks above everything drawn in this one, so
 * nothing 2D can overlap it — see "Controls" at the top of this file. The
 * ffmpeg backend's picture is drawn, and can be overlapped like anything.
 *
 * **mpv and VLC are X11 only.** Both are embedded by window id, which is
 * XEmbed's mechanism; on a react-x11 backend with none — Wayland, the native
 * macOS one — `'auto'` goes to ffmpeg, and an explicit `backend="mpv"` is
 * `'unavailable'` from the first render, with `fallback` showing, rather than
 * a player spawned at a window id that does not exist.
 */
export function MediaPlayer(props: MediaPlayerProps): ReactElement {
  const { backend = 'auto', enabled = true, processes } = props;
  const theme = useTheme() as unknown as Record<string, unknown>;
  const embeddable = canHostXEmbed(useApp());
  const host = useMemo(() => processes ?? nodeProcessHost(), [processes]);
  const route = useRoute(backend, embeddable, host);

  // One handle, over whichever player is mounted: the route can take a PATH
  // probe to settle, and a ref that is null until then — or that changes
  // identity when the route does — is a ref an app cannot call through.
  const inner = useRef<MediaPlayerHandle | null>(null);
  React.useImperativeHandle(
    props.ref,
    () => ({
      play: () => inner.current?.play(),
      pause: () => inner.current?.pause(),
      seek: (seconds: number) => inner.current?.seek(seconds),
      setVolume: (volume: number) => inner.current?.setVolume(volume),
      stop: () => inner.current?.stop(),
      restart: () => inner.current?.restart(),
      signal: (sig?: string) => inner.current?.signal(sig) ?? false,
      get pid() {
        return inner.current?.pid ?? null;
      },
      get windowId() {
        return inner.current?.windowId ?? null;
      },
      get backend() {
        return inner.current?.backend ?? null;
      },
      get status() {
        return inner.current?.status ?? (enabled ? 'starting' : 'idle');
      },
      get reportsProgress() {
        return inner.current?.reportsProgress ?? false;
      },
    }),
    [enabled],
  );

  if (route === null) {
    // Still asking PATH which player there is: the box holds the layout.
    return hx('box', { style: surfaceStyles(theme, props.style) });
  }
  if (route.kind === 'frames') {
    return h(FramesPlayer, { ...props, ref: inner, tried: route.tried });
  }
  return h(EmbeddedPlayer, { ...props, backend: route.backend, ref: inner });
}

/** Which of the two players a `backend` prop comes to. */
type Route =
  | { kind: 'embed'; backend: Exclude<MediaBackendName, 'ffmpeg'> }
  | { kind: 'frames'; tried: readonly string[] };

const FRAMES: Route = { kind: 'frames', tried: [] };

/**
 * The route, or null while PATH is being asked.
 *
 * Only `'auto'` on an app that can embed has to ask: it is mpv or VLC if
 * either is installed, and ffmpeg after them. Everything else is decided by
 * the props and the app on the first render — an explicit player embeds (and
 * says `EmbedUnsupportedError` where it cannot), `'ffmpeg'` decodes, and
 * `'auto'` where nothing can be embedded decodes without looking for a
 * player it could not use.
 */
function useRoute(
  backend: MediaBackendName,
  embeddable: boolean,
  host: ProcessHost,
): Route | null {
  let decided: Route | null = null;
  if (backend === 'ffmpeg') decided = FRAMES;
  else if (backend !== 'auto') decided = { kind: 'embed', backend };
  else if (!embeddable) decided = FRAMES;

  const [asked, setAsked] = useState<{
    host: ProcessHost;
    route: Route;
  } | null>(null);
  const asking = decided === null;
  useEffect(() => {
    if (!asking) return undefined;
    let live = true;
    void (async () => {
      const tried: string[] = [];
      for (const candidate of MEDIA_BACKENDS) {
        for (const binary of candidate.binaries) {
          tried.push(binary);
          if (await host.which(binary)) {
            if (live)
              setAsked({ host, route: { kind: 'embed', backend: 'auto' } });
            return;
          }
        }
      }
      if (live) setAsked({ host, route: { kind: 'frames', tried } });
    })().catch(() => {
      // A host whose `which` throws: the embedded path asks it again in its
      // plan, and reports what it says through `onError` as it always has.
      if (live) setAsked({ host, route: { kind: 'embed', backend: 'auto' } });
    });
    return () => {
      live = false;
    };
  }, [asking, host]);

  if (decided) return decided;
  return asked?.host === host ? asked.route : null;
}

/** mpv or VLC, embedded over `<foreign>`. */
function EmbeddedPlayer(props: MediaPlayerProps): ReactElement {
  const {
    backend = 'auto',
    enabled = true,
    focusable,
    processes,
    stopSignal,
  } = props;
  const theme = useTheme() as unknown as Record<string, unknown>;
  const embeddable = canHostXEmbed(useApp());

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

  const styles = surfaceStyles(theme, props.style);

  if (client.status === 'unavailable' && props.fallback !== undefined) {
    return h(React.Fragment, null, props.fallback);
  }
  // No XEmbed on this app, and no `fallback`: an empty box holds the layout
  // rather than a `<foreign>` with no socket to be — see the same branch in
  // `../terminal/index.ts`.
  if (!embeddable) return hx('box', { style: styles });

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
