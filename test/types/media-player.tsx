// Type-level test: the props, the handle, and the fact that a media player is
// a surface rather than a container.
import { useRef } from 'react';

import { MediaPlayer } from '../../src/index.js';
import type { MediaPlayerHandle, MediaPlayerProps } from '../../src/index.js';

export const asComponent = (
  <box style={{ flexGrow: 1 }}>
    <MediaPlayer
      src="/tmp/clip.mkv"
      backend="mpv"
      autoPlay
      volume={0.8}
      muted={false}
      aspectRatio="16:9"
      loop
      style={{ flexGrow: 1 }}
      onProgress={({ position, duration }) => position / duration}
      onPlayingChange={(playing) => playing}
      onEnded={() => undefined}
      onExit={({ code }) => code}
      fallback={<text>install mpv</text>}
    />
  </box>
);

export function WithHandle(): React.ReactElement {
  const player = useRef<MediaPlayerHandle>(null);
  return (
    <box>
      <MediaPlayer src="https://example.invalid/a.mp4" />
      <box onClick={() => player.current?.play()}>play</box>
      <box onClick={() => player.current?.seek(30)}>skip</box>
    </box>
  );
}

export const props: MediaPlayerProps = { src: '/tmp/clip.mkv' };

// @ts-expect-error volume is a number 0-1, not a percentage string
export const stringVolume = <MediaPlayer volume="80%" />;

// @ts-expect-error 'gstreamer' is not one of the backends
export const unknownBackend = <MediaPlayer backend="gstreamer" />;

// @ts-expect-error the player's window covers the rect; an overlay is a popup
export const withChildren = <MediaPlayer>nope</MediaPlayer>;
