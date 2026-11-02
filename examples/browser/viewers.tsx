// What the browser shows in place of `<Html>`, for a response that is no page
// (`documents.ts`): `<Tree>` for JSON and XML, `<Pdf>` for a PDF and a player
// for a video or a sound. Each is a tab's whole pane and scrolls itself, and
// what it cannot show it says so about and offers to save.
//
// A tab that never shows one loads none of this.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button, Slider, useApp, useSupports } from 'react-x11';
import type { AudioElementNode, VideoNode } from 'react-x11';
import type { Style } from 'react-x11/style';

import { canPlayMedia, videoSource } from '../../src/html/index.js';
import {
  BackendUnavailableError,
  canHostXEmbed,
  nodeProcessHost,
} from '../../src/embed/index.js';
import type { ProcessHost } from '../../src/embed/index.js';
import { MEDIA_BACKENDS, MediaPlayer } from '../../src/media-player/index.js';
import type {
  MediaBackend,
  MediaPlayerHandle,
} from '../../src/media-player/index.js';
import { Pdf } from '../../src/pdf/index.js';
import type { PdfEngine, PdfHandle } from '../../src/pdf/index.js';
import { ValueTree, jsonValue, xmlValue } from './devtools/value-tree.js';
import type { ValueNode } from './devtools/value-tree.js';
import type { Viewer } from './documents.js';

export interface ViewerProps {
  viewer: Viewer;
  /** The browser's zoom, which a PDF takes as its own: a page drawn larger
   *  is drawn again by PDFium, where `scale` would stretch what it drew. */
  zoom: number;
  /** Offer the document to be saved. */
  onSave(): void;
  /** A link in the document was followed, to `url`. */
  onLink(url: string): void;
  /** The document says what it is called. */
  onTitle(title: string): void;
  /** What draws a PDF, and where a player runs: PDFium on a thread and this
   *  machine, but for a test. */
  engine?: PdfEngine;
  processes?: ProcessHost;
}

/** What there is to say where a document cannot be shown, with what can be
 *  done about it. */
export function Refusal({
  message,
  onSave,
}: {
  message: string;
  onSave(): void;
}): ReactElement {
  return (
    <box
      style={{
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        backgroundColor: '$background',
      }}
    >
      <text style={{ color: '$text', maxWidth: 560 }}>{message}</text>
      <Button onPress={onSave}>Save…</Button>
    </box>
  );
}

function TreeOf({ root }: { root: ValueNode }): ReactElement {
  return (
    <box style={{ flexGrow: 1, minHeight: 0, backgroundColor: '$background' }}>
      <ValueTree root={root} fontSize={13} fills />
    </box>
  );
}

function PdfViewer({
  bytes,
  zoom,
  engine,
  onSave,
  onLink,
  onTitle,
}: {
  bytes: Uint8Array;
} & Omit<ViewerProps, 'viewer'>): ReactElement {
  const pdf = useRef<PdfHandle>(null);
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  // the page opens fitted to the pane's width, and the browser's zoom goes
  // from there: at 1 it follows the pane, and past it, this much of that fit
  const fitted = useRef(1);
  useEffect(() => {
    if (zoom === 1) pdf.current?.fit('width');
    else pdf.current?.zoomTo(fitted.current * zoom);
  }, [zoom]);
  return (
    <Pdf
      ref={pdf}
      data={bytes}
      engine={engine}
      onLoad={(document) => {
        if (document.title) onTitle(document.title);
      }}
      onZoomChange={(at) => {
        if (zoomNow.current === 1) fitted.current = at;
      }}
      onLink={({ url }) => {
        if (url) onLink(url);
      }}
      fallback={({ status }) => {
        if (status === 'loading') return null;
        return (
          <Refusal
            onSave={onSave}
            message={
              status === 'unavailable'
                ? 'This browser has no PDF engine: @embedpdf/pdfium is not installed.'
                : status === 'password'
                  ? 'This PDF is protected by a password.'
                  : 'This PDF could not be read.'
            }
          />
        );
      }}
      style={{ flexGrow: 1, minHeight: 0 }}
    />
  );
}

/** Seconds as a player shows them: `1:05`, or `1:01:05` past the hour. */
export function timeOf(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const whole = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  const minutes = Math.floor(whole / 60);
  const rest = `${pad(whole % 60)}`;
  return minutes < 60
    ? `${minutes}:${rest}`
    : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${rest}`;
}

/**
 * What is drawn of a player, at the browser's zoom. A node's scale is its
 * life's, so a new zoom is a new box, and the player stays out of it: in it, a
 * zoom would start the video or the sound again.
 */
function Zoomed({
  zoom,
  style,
  children,
}: {
  zoom: number;
  style?: Style;
  children: ReactNode;
}): ReactElement {
  return (
    <box key={zoom} scale={zoom} style={style}>
      {children}
    </box>
  );
}

/** The bar under a video: core's `<video>` draws none and asks an application
 *  for its own, and `<MediaPlayer>`'s are the player's, off by default. */
function Transport({
  playing,
  position,
  duration,
  onToggle,
  onSeek,
}: {
  playing: boolean;
  position: number;
  duration: number;
  onToggle(): void;
  onSeek(seconds: number): void;
}): ReactElement {
  const known = Number.isFinite(duration) && duration > 0;
  return (
    <box
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        padding: 8,
        flexShrink: 0,
        backgroundColor: '$surface',
      }}
    >
      <Button size="small" onPress={onToggle}>
        {playing ? 'Pause' : 'Play'}
      </Button>
      <box style={{ flexGrow: 1, flexShrink: 1 }}>
        <Slider
          aria-label="Position"
          value={known ? position : 0}
          min={0}
          max={known ? duration : 1}
          disabled={!known}
          onChange={(ev) => onSeek(ev.value)}
        />
      </box>
      <text style={{ color: '$textMuted', fontSize: 12 }}>
        {known ? `${timeOf(position)} / ${timeOf(duration)}` : timeOf(position)}
      </text>
    </box>
  );
}

/**
 * What a bar reads of the platform's player and tells it, which a `<video src>`
 * and an `<audio src>` answer alike: the same props, the same events and the
 * same `ref`.
 */
function usePlayback<
  Player extends {
    readonly paused: boolean;
    play(): void;
    pause(): void;
    seek(seconds: number): void;
  },
>(onFailed: () => void) {
  const node = useRef<Player>(null);
  const [playing, setPlaying] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const toggle = () => {
    if (node.current?.paused) node.current.play();
    else node.current?.pause();
  };
  return {
    toggle,
    element: {
      ref: node,
      onPlay: () => setPlaying(true),
      onPause: () => setPlaying(false),
      onEnded: () => setPlaying(false),
      onTimeUpdate: (ev: { currentTime: number }) =>
        setPosition(ev.currentTime),
      onLoadedMetadata: (ev: { duration: number }) => setDuration(ev.duration),
      onError: onFailed,
    },
    bar: {
      playing,
      position,
      duration,
      onToggle: toggle,
      onSeek: (seconds: number) => node.current?.seek(seconds),
    },
  };
}

/** A video the platform's player opens. */
function PlatformVideo({
  src,
  zoom,
  onFailed,
}: {
  src: string;
  zoom: number;
  onFailed(): void;
}): ReactElement {
  const { element, bar, toggle } = usePlayback<VideoNode>(onFailed);
  return (
    <box style={{ flexGrow: 1, minHeight: 0, backgroundColor: '#000' }}>
      <video
        {...element}
        src={src}
        autoPlay
        style={{ flexGrow: 1, minHeight: 0 }}
        onClick={toggle}
      />
      <Zoomed zoom={zoom}>
        <Transport {...bar} />
      </Zoomed>
    </box>
  );
}

/**
 * What a sound shows, having no picture: what it is called, over its bar.
 * Neither gives way. Zoomed to a fraction of a pixel, two items held at their
 * floors are a line Yoga divides by a rounding residue, and the name came out
 * 249 million pixels tall (react-x11#411).
 */
function SoundCard({
  name,
  zoom,
  children,
}: {
  name: string;
  zoom: number;
  children?: ReactNode;
}): ReactElement {
  return (
    <Zoomed
      zoom={zoom}
      style={{
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backgroundColor: '$background',
      }}
    >
      <box style={{ width: '100%', maxWidth: 560, gap: 8 }}>
        <text
          style={{
            color: '$text',
            flexShrink: 0,
            marginLeft: 8,
            textWrap: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {name}
        </text>
        {children}
      </box>
    </Zoomed>
  );
}

/** A sound the platform's player opens: core's `<audio>`, which takes no room
 *  and draws nothing, so the card is all there is to see. */
function PlatformAudio({
  src,
  name,
  zoom,
  onFailed,
}: {
  src: string;
  name: string;
  zoom: number;
  onFailed(): void;
}): ReactElement {
  const { element, bar } = usePlayback<AudioElementNode>(onFailed);
  return (
    <>
      <audio {...element} src={src} autoPlay />
      <SoundCard name={name} zoom={zoom}>
        <Transport {...bar} />
      </SoundCard>
    </>
  );
}

/** mpv's and VLC's own flag: a file's cover is a video track to either, and
 *  drawn by a player in a window nobody can see. */
const NO_PICTURE = ['--no-video'];

/** Where a player goes that only makes a sound: `<foreign>` is a window, and
 *  a window has a pixel at the least. */
const UNSEEN = { position: 'absolute', width: 1, height: 1 } as const;

/**
 * Something another program plays, where the platform has no player: a video
 * in mpv, in VLC or in ffmpeg, which is silent (`<MediaPlayer>`), and a sound
 * in the first two (`sound`). Nothing starts until the reader presses Play:
 * that program is a native decoder with none of a browser's sandbox, and a
 * link should not be able to hand it a stranger's file by being followed.
 */
function ProgramPlayer({
  src,
  zoom,
  sound,
  processes,
  onSave,
}: {
  src: string;
  zoom: number;
  /** A sound: what it is called, and the program that has been found for it. */
  sound?: { name: string; program: MediaBackend['name'] };
  processes?: ProcessHost;
  onSave(): void;
}): ReactElement {
  const player = useRef<MediaPlayerHandle>(null);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState({ position: 0, duration: 0 });
  const [failure, setFailure] = useState<string | null>(null);
  // mpv waits, idle, past a file's end, where `play()` finds nothing to play
  const ended = useRef(false);
  const toggle = () => {
    if (started && !ended.current) {
      if (playing) player.current?.pause();
      else player.current?.play();
      return;
    }
    if (started) player.current?.restart();
    ended.current = false;
    setStarted(true);
    // VLC says nothing of having started, so this is not waited for
    setPlaying(true);
  };
  if (failure) return <Refusal message={failure} onSave={onSave} />;
  const surface = (
    <MediaPlayer
      ref={player}
      src={src}
      enabled={started}
      backend={sound?.program ?? 'auto'}
      extraArgs={sound ? NO_PICTURE : undefined}
      processes={processes}
      onProgress={setProgress}
      onPlayingChange={setPlaying}
      onEnded={() => {
        ended.current = true;
        setPlaying(false);
      }}
      fallback={null}
      onError={(error) =>
        setFailure(
          sound
            ? 'This audio could not be played.'
            : error instanceof BackendUnavailableError
              ? 'Nothing on this machine plays this video: it needs mpv, VLC or ffmpeg.'
              : 'This video could not be played.',
        )
      }
      style={sound ? UNSEEN : { flexGrow: 1, minHeight: 0 }}
    />
  );
  const bar = (
    <Transport
      playing={playing}
      position={progress.position}
      duration={progress.duration}
      onToggle={toggle}
      onSeek={(seconds) => player.current?.seek(seconds)}
    />
  );
  if (sound) {
    return (
      <>
        {surface}
        <SoundCard name={sound.name} zoom={zoom}>
          {bar}
        </SoundCard>
      </>
    );
  }
  return (
    <box style={{ flexGrow: 1, minHeight: 0, backgroundColor: '#000' }}>
      {surface}
      <Zoomed zoom={zoom}>{bar}</Zoomed>
    </box>
  );
}

/**
 * The program that plays a sound here, which `backend="auto"` cannot say: it
 * comes to ffmpeg after mpv and VLC, and ffmpeg is silent. Undefined while
 * `PATH` is asked, and null for neither. Asking runs nothing.
 */
function useSoundProgram(
  embeds: boolean,
  processes?: ProcessHost,
): MediaBackend['name'] | null | undefined {
  const [found, setFound] = useState<MediaBackend['name'] | null>();
  useEffect(() => {
    if (!embeds) return undefined;
    let live = true;
    const host = processes ?? nodeProcessHost();
    void (async () => {
      for (const { name, binaries } of MEDIA_BACKENDS) {
        for (const binary of binaries) {
          if (await host.which(binary)) return name;
        }
      }
      return null;
    })()
      .catch(() => null)
      .then((name) => {
        if (live) setFound(name);
      });
    return () => {
      live = false;
    };
  }, [embeds, processes]);
  return embeds ? found : null;
}

/** A sound with no platform's player: mpv and VLC are embedded by window id,
 *  so this is X11's, and a backend that cannot embed has nothing to ask. */
function ProgramAudio({
  src,
  name,
  zoom,
  processes,
  onSave,
}: {
  src: string;
  name: string;
  zoom: number;
  processes?: ProcessHost;
  onSave(): void;
}): ReactElement {
  const embeds = canHostXEmbed(useApp());
  const program = useSoundProgram(embeds, processes);
  if (program === undefined) return <SoundCard name={name} zoom={zoom} />;
  if (program === null) {
    return (
      <Refusal
        onSave={onSave}
        message={
          embeds
            ? 'Nothing on this machine plays this audio: it needs mpv or VLC.'
            : 'This browser has no player for this audio.'
        }
      />
    );
  }
  return (
    <ProgramPlayer
      src={src}
      zoom={zoom}
      sound={{ name, program }}
      processes={processes}
      onSave={onSave}
    />
  );
}

function VideoViewer({
  src,
  type,
  zoom,
  processes,
  onSave,
}: {
  src: string;
  type: string;
  zoom: number;
  processes?: ProcessHost;
  onSave(): void;
}): ReactElement {
  const plays = useSupports('mediaPlayback');
  const [failed, setFailed] = useState(false);
  const own = plays && canPlayMedia(type) ? videoSource(src, type, src) : null;
  if (failed) {
    return (
      <Refusal onSave={onSave} message="This video could not be played." />
    );
  }
  if (own) {
    return (
      <PlatformVideo src={own} zoom={zoom} onFailed={() => setFailed(true)} />
    );
  }
  return (
    <ProgramPlayer
      src={src}
      zoom={zoom}
      processes={processes}
      onSave={onSave}
    />
  );
}

function AudioViewer({
  src,
  type,
  name,
  zoom,
  processes,
  onSave,
}: {
  src: string;
  type: string;
  name: string;
  zoom: number;
  processes?: ProcessHost;
  onSave(): void;
}): ReactElement {
  const plays = useSupports('mediaPlayback');
  const [failed, setFailed] = useState(false);
  // Any type but those it is known not to read, where a video asks for those
  // it is known to: a sound has no other player to go to on the backends that
  // have this one, and it reads more than `canPlayMedia` lists, FLAC among them.
  const own = plays ? videoSource(src, type, src) : null;
  if (failed) {
    return (
      <Refusal onSave={onSave} message="This audio could not be played." />
    );
  }
  if (own) {
    return (
      <PlatformAudio
        src={own}
        name={name}
        zoom={zoom}
        onFailed={() => setFailed(true)}
      />
    );
  }
  return (
    <ProgramAudio
      src={src}
      name={name}
      zoom={zoom}
      processes={processes}
      onSave={onSave}
    />
  );
}

export default function DocumentViewer(props: ViewerProps): ReactElement {
  const { viewer } = props;
  const root = useMemo(() => {
    if (viewer.kind === 'json') return jsonValue(viewer.value);
    if (viewer.kind !== 'xml') return null;
    const element = viewer.document.children.find((n) => n.type === 'tag');
    return element ? xmlValue(element) : null;
  }, [viewer]);
  if (root) return <TreeOf root={root} />;
  if (viewer.kind === 'pdf') {
    return <PdfViewer bytes={viewer.bytes} {...props} />;
  }
  if (viewer.kind === 'video') {
    return (
      <VideoViewer
        src={viewer.src}
        type={viewer.type}
        zoom={props.zoom}
        processes={props.processes}
        onSave={props.onSave}
      />
    );
  }
  if (viewer.kind === 'audio') {
    return (
      <AudioViewer
        src={viewer.src}
        type={viewer.type}
        name={viewer.name}
        zoom={props.zoom}
        processes={props.processes}
        onSave={props.onSave}
      />
    );
  }
  return <Refusal message="There is nothing to show." onSave={props.onSave} />;
}
