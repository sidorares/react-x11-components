// What a media player can be told, and what it can say back.
//
// Two backends implement this and they are not equals, which is the honest
// shape of the problem rather than a gap to paper over: mpv has a JSON IPC
// socket that reports properties as they change, so `onProgress` is real
// events; VLC's rc interface is a line-oriented console whose replies are
// unlabelled text, so this package writes to it and does not parse it —
// play/pause/seek/volume work, position does not. `reportsProgress` is how a
// caller finds that out without knowing which binary was picked.

/** What the player tells the component. */
export interface PlayerEvents {
  onProgress?: (info: { position: number; duration: number }) => void;
  onPlayingChange?: (playing: boolean) => void;
  onEnded?: () => void;
  /** The control channel failed. The video may well still be playing. */
  onError?: (err: Error) => void;
}

/** What the component tells the player. */
export interface PlayerControl {
  /** Replace what is playing, without restarting the process. */
  load(src: string): void;
  setPaused(paused: boolean): void;
  /** Absolute position, in seconds. */
  seek(seconds: number): void;
  /** 0–1. Scaled to whatever the backend's own range is. */
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  stop(): void;
  /** Whether `onProgress` will ever fire. False for VLC — see the file
   *  comment. */
  readonly reportsProgress: boolean;
  dispose(): void;
}

/**
 * `chunk => lines`, keeping the partial one.
 *
 * Both control protocols are newline-delimited and both arrive over a stream
 * socket, so a message can be split across two reads and two messages can
 * arrive in one. Shared rather than written twice because getting this wrong
 * shows up as an occasional dropped event, which is the hardest kind of bug to
 * see in a progress bar.
 */
export function lineReader(
  onLine: (line: string) => void,
): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
      index = buffer.indexOf('\n');
    }
    // A runaway peer must not become a runaway allocation: nothing either
    // protocol sends is anywhere near this long, so a buffer this size means
    // the stream is not what we think it is.
    if (buffer.length > 1_000_000) buffer = '';
  };
}

/** Clamp to 0–1 and reject the values a slider bound to bad state produces. */
export function unitRange(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
