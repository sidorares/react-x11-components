// Run with: npm run examples:media-player -- /path/to/video.mkv
// (needs mpv or VLC on X11, or ffmpeg and ffprobe on any backend —
// `MEDIA_BACKEND=ffmpeg` asks for ffmpeg where mpv would be found first)
//
// A video surface with a transport bar drawn in react-x11 underneath it. Note
// where the bar is: *beside* the player, not over it. An embedded player's X
// window stacks above everything drawn in ours — the same rule `<glarea>` has
// — so an overlay would have to be a sibling `<popup>`. ffmpeg's picture is a
// drawn `<video>`, which a bar could overlap; this one stays beside it so the
// example looks the same on every backend.
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { MediaPlayer } from '../src/media-player/index.js';
import type {
  MediaBackendName,
  MediaPlayerHandle,
} from '../src/media-player/index.js';

const src = process.argv[2];
const backend = process.env.MEDIA_BACKEND as MediaBackendName | undefined;

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(whole / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function App(): ReactElement {
  const player = useRef<MediaPlayerHandle>(null);
  const [{ position, duration }, setProgress] = useState({
    position: 0,
    duration: 0,
  });
  const [playing, setPlaying] = useState(true);
  const [volume, setVolume] = useState(0.8);

  const fraction = duration > 0 ? position / duration : 0;

  return (
    <window
      width={760}
      height={480}
      title="@react-x11/components — MediaPlayer"
    >
      <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        <MediaPlayer
          ref={player}
          src={src}
          backend={backend}
          volume={volume}
          aspectRatio="16:9"
          style={{ flexGrow: 1 }}
          onProgress={setProgress}
          onPlayingChange={setPlaying}
          onEnded={() => setPlaying(false)}
          fallback={
            <box style={{ flexGrow: 1, padding: 24 }}>
              <text style={{ fontSize: 13, color: '$textMuted' }}>
                No media player found. Install mpv (preferred on X11 — it has
                sound and reports position back), VLC, or ffmpeg, which plays
                silently on every backend.
              </text>
            </box>
          }
        />

        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 10,
            backgroundColor: '$surfaceHover',
          }}
        >
          <box
            style={{
              padding: 6,
              borderRadius: 4,
              backgroundColor: '$surfaceActive',
              cursor: 'pointer',
            }}
            onClick={() =>
              playing ? player.current?.pause() : player.current?.play()
            }
          >
            <text style={{ fontSize: 11, color: '$text' }}>
              {playing ? 'pause' : 'play'}
            </text>
          </box>

          <text style={{ fontSize: 11, color: '$textMuted' }}>
            {`${clock(position)} / ${clock(duration)}`}
          </text>

          {/* A scrub bar: click anywhere in it to seek. */}
          <box
            style={{
              flexGrow: 1,
              height: 6,
              borderRadius: 3,
              backgroundColor: '$track',
              cursor: 'pointer',
            }}
            onClick={(ev) => {
              const width = ev.currentTarget?.abs.width ?? 0;
              if (width > 0 && duration > 0) {
                player.current?.seek((ev.x / width) * duration);
              }
            }}
          >
            <box
              style={{
                width: `${Math.round(fraction * 100)}%`,
                height: 6,
                borderRadius: 3,
                backgroundColor: '$accent',
              }}
            />
          </box>

          <box
            style={{ padding: 6, cursor: 'pointer' }}
            onClick={() => setVolume((v) => (v > 0 ? 0 : 0.8))}
          >
            <text style={{ fontSize: 11, color: '$textMuted' }}>
              {volume > 0 ? 'mute' : 'unmute'}
            </text>
          </box>
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  if (!src) {
    console.error('usage: npm run examples:media-player -- <file-or-url>');
    process.exit(1);
  }
  const root = await createRoot();
  root.render(<App />);
}
