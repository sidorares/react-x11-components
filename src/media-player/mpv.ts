// mpv's JSON IPC, which is what makes `<MediaPlayer>`'s props real control
// rather than decoration.
//
// `--input-ipc-server=PATH` gives a unix socket that speaks newline-delimited
// JSON in both directions: `{"command":[…]}` out, `{"event":…}` and
// `{"request_id":…}` back. Two things it buys that a command line cannot:
//
//  - **`observe_property`.** Position, duration, pause state and volume are
//    pushed as they change, so `onProgress` is an event rather than a poll.
//  - **`loadfile … replace`.** A new `src` swaps the file inside the running
//    player, so the embedded window never blinks and the process never has to
//    be respawned.
//
// The socket is created by mpv some milliseconds *after* it starts, which is
// what `connectWhenReady` in `../embed/host.ts` is for.
import { connectWhenReady } from '../embed/index.js';
import type { IpcSocket, ProcessHost } from '../embed/index.js';
import { lineReader, unitRange } from './control.js';
import type { PlayerControl, PlayerEvents } from './control.js';

/** Observation ids. mpv echoes them back on every property-change, and they
 *  are ours to choose. */
const OBSERVE = {
  position: 1,
  duration: 2,
  pause: 3,
} as const;

/** mpv's volume is a percentage and goes above 100 (`--volume-max`); the prop
 *  is 0–1, so this is the whole of the conversion. */
const VOLUME_SCALE = 100;

interface MpvMessage {
  event?: string;
  id?: number;
  name?: string;
  data?: unknown;
  reason?: string;
  error?: string;
}

export async function connectMpv(
  host: ProcessHost,
  socketPath: string,
  events: PlayerEvents,
): Promise<PlayerControl> {
  const socket: IpcSocket = await connectWhenReady(host, socketPath);

  let position = 0;
  let duration = 0;
  let disposed = false;

  const send = (command: readonly unknown[]): void => {
    if (disposed) return;
    socket.write(`${JSON.stringify({ command })}\n`);
  };

  const observe = (id: number, property: string): void => {
    send(['observe_property', id, property]);
  };

  socket.onData(
    lineReader((line) => {
      let message: MpvMessage;
      try {
        message = JSON.parse(line) as MpvMessage;
      } catch {
        // mpv only ever writes JSON here; a line that is not is a version
        // saying something we do not understand, and dropping it is right.
        return;
      }

      if (message.event === 'property-change') {
        if (
          message.id === OBSERVE.position &&
          typeof message.data === 'number'
        ) {
          position = message.data;
          events.onProgress?.({ position, duration });
        } else if (
          message.id === OBSERVE.duration &&
          typeof message.data === 'number'
        ) {
          duration = message.data;
          events.onProgress?.({ position, duration });
        } else if (message.id === OBSERVE.pause) {
          events.onPlayingChange?.(message.data !== true);
        }
        return;
      }

      // `end-file` fires for every way a file stops, including the ones a
      // caller must not hear as "the video finished": `stop` is our own
      // `stop()`, and `redirect` is a playlist indirection mid-load.
      if (message.event === 'end-file') {
        if (message.reason === 'eof') events.onEnded?.();
        return;
      }

      if (message.event === 'start-file') {
        position = 0;
        duration = 0;
      }
    }),
  );

  socket.onClose(() => {
    if (disposed) return;
    disposed = true;
    // Not an error: mpv closing its socket is mpv exiting, which the process
    // watch in `useEmbeddedClient` reports with an exit code.
  });

  observe(OBSERVE.position, 'time-pos');
  observe(OBSERVE.duration, 'duration');
  observe(OBSERVE.pause, 'pause');

  return {
    reportsProgress: true,
    load(src) {
      // `replace` rather than `append`: the prop names what is playing, so
      // setting it twice must not build a playlist.
      send(['loadfile', src, 'replace']);
    },
    setPaused(paused) {
      send(['set_property', 'pause', paused]);
    },
    seek(seconds) {
      if (!Number.isFinite(seconds)) return;
      send(['seek', Math.max(0, seconds), 'absolute']);
    },
    setVolume(volume) {
      send(['set_property', 'volume', unitRange(volume) * VOLUME_SCALE]);
    },
    setMuted(muted) {
      send(['set_property', 'mute', muted]);
    },
    stop() {
      send(['stop']);
    },
    dispose() {
      disposed = true;
      socket.close();
    },
  };
}
