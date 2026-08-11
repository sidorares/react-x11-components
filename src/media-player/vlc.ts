// VLC's rc interface, used write-only — and the asymmetry is the point.
//
// `--extraintf rc --rc-unix=PATH` gives a unix socket that accepts the same
// console commands VLC's `rc` module has always accepted: `play`, `pause`,
// `stop`, `seek N`, `volume N`, `add URI`. That is enough for every control
// `<MediaPlayer>` exposes.
//
// What it is *not* enough for is `onProgress`. The replies to `get_time` and
// `get_length` are bare numbers with a `>` prompt around them, in a stream
// that also carries unsolicited status blocks and localised text — there is no
// request id, so a reply cannot be matched to the question that asked for it
// except by counting, and a dropped or extra line desynchronises the count
// permanently. Rather than ship a parser that is wrong in a way nobody
// notices until a progress bar lies, this backend declares
// `reportsProgress: false` and the component reports position only under mpv.
//
// The other consequence of not reading: `pause` in the rc protocol *toggles*.
// So the intended state is tracked here, seeded from `autoPlay`, and
// `setPaused` sends a toggle only when the two disagree. That is exact as long
// as nobody else is driving the same player, which is the case for a player
// this component spawned.
import { connectWhenReady } from '../embed/index.js';
import type { IpcSocket, ProcessHost } from '../embed/index.js';
import { unitRange } from './control.js';
import type { PlayerControl, PlayerEvents } from './control.js';

/** VLC's rc `volume` takes 0–256 for 0–100%. */
const VOLUME_SCALE = 256;

export interface VlcConnectOptions {
  /** What the player was started doing, so the toggle stays in step. */
  paused: boolean;
}

export async function connectVlc(
  host: ProcessHost,
  socketPath: string,
  events: PlayerEvents,
  options: VlcConnectOptions,
): Promise<PlayerControl> {
  const socket: IpcSocket = await connectWhenReady(host, socketPath);

  let paused = options.paused;
  let volume = 1;
  let disposed = false;

  const send = (line: string): void => {
    if (disposed) return;
    socket.write(`${line}\n`);
  };

  // Read and discard. The stream has to be consumed — an unread socket
  // eventually stops the writer — and nothing in it is parsed, for the reason
  // in the file comment.
  socket.onData(() => {});
  socket.onClose(() => {
    disposed = true;
  });

  return {
    reportsProgress: false,
    load(src) {
      send(`add ${src}`);
      paused = false;
      events.onPlayingChange?.(true);
    },
    setPaused(next) {
      if (next === paused) return;
      // `pause` toggles; `play` is unambiguous, so resuming uses it and only
      // pausing needs the toggle.
      send(next ? 'pause' : 'play');
      paused = next;
      events.onPlayingChange?.(!next);
    },
    seek(seconds) {
      if (!Number.isFinite(seconds)) return;
      send(`seek ${Math.max(0, Math.round(seconds))}`);
    },
    setVolume(next) {
      volume = unitRange(next);
      send(`volume ${Math.round(volume * VOLUME_SCALE)}`);
    },
    setMuted(muted) {
      // rc has no mute: 0 and back is what the command set can express.
      send(`volume ${muted ? 0 : Math.round(volume * VOLUME_SCALE)}`);
    },
    stop() {
      send('stop');
      paused = true;
      events.onPlayingChange?.(false);
    },
    dispose() {
      disposed = true;
      socket.close();
    },
  };
}
