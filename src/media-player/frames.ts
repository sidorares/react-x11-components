// `<MediaPlayer backend="ffmpeg">`: the component half of `./ffmpeg.ts`.
//
// Three steps, each an effect keyed on exactly what invalidates it:
//
// 1. **Find ffmpeg and ffprobe** on the host, and probe `src` for the size
//    and colour to decode to. A throwaway sink is made first, because asking
//    a display for its formats is not free everywhere: on X11 it is an Xv
//    port, a few round trips that run while ffprobe does — the same move
//    react-x11's `examples/video.jsx` makes.
// 2. **A sink** from core's `useVideoFrames`, in the display's first
//    `preferredFormats` entry, which is the format ffmpeg is told to emit:
//    NV12 where something native takes it, BGRA where every frame would
//    otherwise be converted in JavaScript.
// 3. **A `FramesSession`** over that sink, which is the transport — and is
//    replaced, never reconfigured, when the clip or a launch prop changes.
//
// What renders is a core `<video frames>`: a drawn node, in the paint order.
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import { createVideoFrames, useApp, useTheme, useVideoFrames } from 'react-x11';
import type { VideoProps } from 'react-x11';

import { BackendUnavailableError, nodeProcessHost } from '../embed/index.js';
import type { EmbedStatus, ProcessHost } from '../embed/index.js';
import { FRAMES_FORMATS, FramesSession, probeClip } from './ffmpeg.js';
import type { FramesFormat, ProbedClip } from './ffmpeg.js';
import { hx } from './hx.js';
import type {
  MediaPlayerHandle,
  MediaPlayerProps,
  MediaProgress,
} from './index.js';
import { surfaceStyles } from './surface.js';

const h = React.createElement;

/** `<video>`'s props as `hx` takes them. */
type VideoElementProps = Omit<VideoProps, 'theme'>;

export interface FramesPlayerProps extends MediaPlayerProps {
  /** What was looked for before this backend was, so that "nothing is
   *  installed" names all of it — `['mpv', 'vlc']` when `'auto'` fell
   *  through on an app that could have embedded either. */
  tried?: readonly string[];
}

/** A clip ready to decode: where, what to, and with which binary. */
interface Prepared {
  src: string;
  ffmpeg: string;
  clip: ProbedClip;
  format: FramesFormat;
}

/** The sink's options before there is a clip — never shown. */
const NO_CLIP = { width: 2, height: 2 } as const;

/** ffmpeg and ffprobe on `host`, or the `BackendUnavailableError` that says
 *  which one is missing. */
async function findTools(
  host: ProcessHost,
  tried: readonly string[],
): Promise<{ ffmpeg: string; ffprobe: string }> {
  const ffmpeg = await host.which('ffmpeg');
  if (!ffmpeg) {
    throw new BackendUnavailableError('media player', [...tried, 'ffmpeg']);
  }
  const ffprobe = await host.which('ffprobe');
  if (!ffprobe) {
    throw new BackendUnavailableError('media player', [
      ...tried,
      'ffmpeg',
      'ffprobe',
    ]);
  }
  return { ffmpeg, ffprobe };
}

export function FramesPlayer(props: FramesPlayerProps): ReactElement {
  const { enabled = true, processes, stopSignal, src, aspectRatio } = props;
  const app = useApp();
  const theme = useTheme() as unknown as Record<string, unknown>;
  const host = useMemo(() => processes ?? nodeProcessHost(), [processes]);

  const latest = useRef(props);
  latest.current = props;

  const [status, setStatus] = useState<EmbedStatus>('idle');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  // `stop()` takes the picture down; the next start puts it back.
  const [blank, setBlank] = useState(false);
  const [generation, setGeneration] = useState(0);
  // Bumped when a session starts, for the same reason the embedded path
  // bumps `channel`: "apply `paused` to the session there now is" is a
  // dependency, not a retry.
  const [channel, setChannel] = useState(0);
  const session = useRef<FramesSession | null>(null);

  // What the transport should be doing, across sessions: a new `src` plays
  // on if the old one was playing and stays paused if it was paused, as
  // mpv's `loadfile … replace` does.
  const initiallyPaused = (): boolean =>
    latest.current.paused ?? !(latest.current.autoPlay ?? true);
  const wantPaused = useRef(initiallyPaused());

  const tried = props.tried ?? [];
  const triedKey = tried.join(',');

  // --- 1. the tools and the probe ------------------------------------------

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      setPrepared(null);
      return undefined;
    }
    let live = true;
    void (async () => {
      // A new `src` for a running player keeps it running until the new
      // clip is ready, so only a player with nothing to show is starting.
      if (!session.current) setStatus('starting');
      const tools = await findTools(host, triedKey ? triedKey.split(',') : []);
      if (!live) return;
      // Nothing to play is a player waiting for a file, as an idle mpv is.
      if (src === undefined || src === '') {
        setPrepared(null);
        setStatus('idle');
        return;
      }
      const asking = createVideoFrames(app, NO_CLIP);
      try {
        const clip = await probeClip(host, tools.ffprobe, src, aspectRatio);
        if (!live) return;
        const format =
          asking.preferredFormats.find((f) => FRAMES_FORMATS.includes(f)) ??
          'BGRA';
        setPrepared({ src, ffmpeg: tools.ffmpeg, clip, format });
      } finally {
        asking.close();
      }
    })().catch((err: unknown) => {
      if (!live) return;
      const wrapped = err instanceof Error ? err : new Error(String(err));
      // "no ffmpeg on this machine" is the ordinary kind of news, and the
      // only one worth a fallback; a file ffprobe cannot read is a failure.
      setStatus(
        wrapped instanceof BackendUnavailableError ? 'unavailable' : 'exited',
      );
      latest.current.onError?.(wrapped);
    });
    return () => {
      live = false;
    };
  }, [enabled, host, app, src, aspectRatio, triedKey, generation]);

  // --- 2. the sink ----------------------------------------------------------

  const frames = useVideoFrames(
    prepared
      ? {
          width: prepared.clip.width,
          height: prepared.clip.height,
          format: prepared.format,
          colorSpace: prepared.clip.colorSpace,
          range: prepared.clip.range,
        }
      : NO_CLIP,
  );

  // --- 3. the session -------------------------------------------------------

  // The props that cannot change under a running decoder — the embedded
  // path's launch key, less what this backend reads elsewhere: `aspectRatio`
  // is the probe's, and `osd` means nothing here.
  const key = useMemo(
    () => JSON.stringify([props.loop ?? false, props.extraArgs ?? null]),
    [props.loop, props.extraArgs],
  );

  useEffect(() => {
    if (!prepared) return undefined;
    const current = latest.current;
    const started = new FramesSession({
      host,
      command: prepared.ffmpeg,
      launch: {
        src: prepared.src,
        clip: prepared.clip,
        format: prepared.format,
        loop: current.loop,
        extraArgs: current.extraArgs,
      },
      sink: frames,
      stopSignal,
      events: {
        onProgress: (progress: MediaProgress) =>
          latest.current.onProgress?.(progress),
        onPlayingChange: (playing: boolean) => {
          if (playing) setStatus('running');
          latest.current.onPlayingChange?.(playing);
        },
        onEnded: () => latest.current.onEnded?.({ node: null }),
        onError: (err: Error) => latest.current.onError?.(err),
        onExit: (info) => {
          setStatus('exited');
          latest.current.onExit?.(info);
        },
        onStopped: setBlank,
      },
    });
    session.current = started;
    setBlank(false);
    setStatus('running');
    setChannel((n) => n + 1);
    started.start(0, wantPaused.current);
    return () => {
      started.dispose();
      if (session.current === started) session.current = null;
    };
  }, [prepared, frames, key, host, stopSignal]);

  const { paused } = props;
  useEffect(() => {
    if (paused === undefined) return;
    wantPaused.current = paused;
    session.current?.setPaused(paused);
  }, [paused, channel]);

  // --- the handle ------------------------------------------------------------

  const setPaused = useCallback((value: boolean) => {
    wantPaused.current = value;
    session.current?.setPaused(value);
  }, []);

  useImperativeHandle(
    props.ref,
    (): MediaPlayerHandle => ({
      play: () => setPaused(false),
      pause: () => setPaused(true),
      seek: (seconds: number) => session.current?.seek(seconds),
      // Silent: a sink is frames, not sound.
      setVolume: () => {},
      stop: () => session.current?.stop(),
      restart: () => {
        wantPaused.current = initiallyPaused();
        setGeneration((n) => n + 1);
      },
      signal: (sig = 'SIGTERM') => session.current?.signal(sig) ?? false,
      get pid() {
        return session.current?.pid ?? null;
      },
      windowId: null,
      backend: status === 'unavailable' || status === 'idle' ? null : 'ffmpeg',
      status,
      reportsProgress: true,
    }),
    // `initiallyPaused` reads a ref; it is a function only to share it.
    [setPaused, status],
  );

  if (status === 'unavailable' && props.fallback !== undefined) {
    return h(React.Fragment, null, props.fallback);
  }

  const video: VideoElementProps = {
    frames: prepared && !blank ? frames : undefined,
    // A video surface is not something to tab to — the embedded path's rule.
    focusable: props.focusable ?? false,
    'aria-label': 'Media player',
    style: surfaceStyles(theme, props.style),
  };
  // `data-testname` is a runtime convention react-x11's element declarations
  // do not carry — the note in `./index.ts`.
  return hx('video', {
    ...video,
    'data-testname': props['data-testname'],
  } as VideoElementProps);
}
