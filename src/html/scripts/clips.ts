// The host's half of a `MediaSource` (`mse.ts`): a page's appended VP9 kept
// here, and handed to the platform's player as a file once the stream ends.
//
// **The player opens a file, so a clip waits for its end.** AVFoundation takes
// a path or a URL, and nothing here can hand it bytes as they arrive, so the
// packets are kept as they come and written out (`mp4.ts`) when the page says
// the stream is whole. That is why `MediaSource.isTypeSupported` still says no
// to VP9, and only `addSourceBuffer` says yes: a page that asks is choosing a
// streaming player, which would append for an hour and show nothing, and has
// another way to play what it plays. What a page gives no thought to is a
// clip it fetched whole, which is what this is for: Apple's product pages
// fetch a few seconds of VP9 and move `currentTime` with the scroll.
//
// **The bytes stay here.** Only sizes, times and a path's existence cross to
// the page's realm.

import type { Element } from 'domhandler';

import { vp9Mp4 } from './mp4.js';
import { nodeModule } from './platform.js';
import { WebmReader } from './webm.js';
import type { WebmPacket } from './webm.js';

interface FsPromises {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(
    file: string,
    data: Uint8Array,
    options: { mode: number },
  ): Promise<void>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
}

const fs = await nodeModule<FsPromises>('fs/promises');
const { tmpdir } = await nodeModule<{ tmpdir(): string }>('os');
const { dirname, join } = await nodeModule<{
  dirname(path: string): string;
  join(...parts: string[]): string;
}>('path');

/** A clip as a file in a directory of its own, which only this user reads:
 *  what a page appended is the page's. */
export async function writeClip(pieces: Uint8Array[]): Promise<string> {
  const whole = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const piece of pieces) {
    whole.set(piece, at);
    at += piece.length;
  }
  const dir = await fs.mkdtemp(join(tmpdir(), 'html-clip-'));
  const file = join(dir, 'clip.mp4');
  await fs.writeFile(file, whole, { mode: 0o600 });
  return file;
}

/** Takes a file `writeClip` made away, and its directory. */
export function removeClip(file: string): void {
  void fs.rm(dirname(file), { recursive: true, force: true }).catch(() => {
    // the temporary directory is allowed to have been cleaned already
  });
}

/** What a clip needs of the host. */
export interface ClipSeams {
  /** Whether what plays the page's video plays `type`. */
  plays(type: string): boolean;
  /** Writes a file of these pieces, and answers its path. */
  write(pieces: Uint8Array[]): Promise<string>;
  /** Takes a file `write` made away. */
  remove(path: string): void;
  /** What the element's player is to play, or null for nothing any more. */
  show(element: Element, file: string | null): void;
}

/** What an append came to, as the page's realm reads it. */
export interface AppendResult {
  /** The stream can be read no further. */
  failed?: true;
  /** What its head said, once it has. */
  width?: number;
  height?: number;
  duration?: number;
  /** What is buffered, in seconds. */
  ranges: [number, number][];
}

/** The type a player's file can be made from: WebM's VP9, with its codec
 *  named, since a `SourceBuffer` is made for what it says it will hold. */
const VP9_WEBM =
  /^\s*video\/webm\s*;\s*codecs\s*=\s*"?\s*(?:vp9|vp09\.[\d.]+)\s*"?\s*$/i;
/** The `canPlayType` a file made here has to pass: VP9's MP4 binding. */
const VP9_MP4 = 'video/mp4; codecs="vp09.00.10.08"';

/** How far apart two packets may be for the stream to run on between them,
 *  in frames: MSE's coded frame groups, for a stream with no timing of its
 *  own to say. */
const GAP_FRAMES = 2.5;

interface Clip {
  reader: WebmReader;
  packets: WebmPacket[];
  element: Element;
  told: boolean;
  file: string | null;
  /** Which file this is, of those a clip has been written to: a write that
   *  finds another has been overtaken. */
  writes: number;
}

export class VideoClips {
  private readonly _clips = new Map<number, Clip>();
  private _next = 1;

  constructor(private readonly _seams: ClipSeams) {}

  /** A clip for a `SourceBuffer` of `type`, or 0 where nothing would play it. */
  open(type: string, element: Element): number {
    if (!VP9_WEBM.test(type) || !this._seams.plays(VP9_MP4)) return 0;
    // the one track a player's file has
    for (const clip of this._clips.values()) {
      if (clip.element === element) return 0;
    }
    const id = this._next;
    this._next += 1;
    this._clips.set(id, {
      reader: new WebmReader(),
      packets: [],
      element,
      told: false,
      file: null,
      writes: 0,
    });
    return id;
  }

  append(id: number, bytes: Uint8Array): AppendResult {
    const clip = this._clips.get(id);
    if (!clip) return { failed: true, ranges: [] };
    const { reader } = clip;
    for (const packet of reader.push(bytes)) insert(clip.packets, packet);
    const out: AppendResult = { ranges: rangesOf(clip.packets) };
    if (reader.failed) out.failed = true;
    if (reader.video && !clip.told) {
      clip.told = true;
      out.width = reader.video.width;
      out.height = reader.video.height;
      out.duration = reader.duration ?? out.ranges.at(-1)?.[1] ?? 0;
    }
    return out;
  }

  /** MSE 3.5's range removal: what shows from `start` until `end` goes. */
  remove(id: number, start: number, end: number): AppendResult {
    const clip = this._clips.get(id);
    if (!clip) return { ranges: [] };
    clip.packets = clip.packets.filter((p) => p.time < start || p.time >= end);
    return { ranges: rangesOf(clip.packets) };
  }

  /** The stream is whole: its file written, and handed to the player. */
  end(id: number): void {
    const clip = this._clips.get(id);
    if (!clip?.reader.video || !clip.packets.length) return;
    clip.writes += 1;
    const write = clip.writes;
    const { width, height, colour } = clip.reader.video;
    const pieces = vp9Mp4(
      { width, height, colour, duration: clip.reader.duration },
      clip.packets,
    );
    void this._seams.write(pieces).then(
      (path) => {
        if (this._clips.get(id) !== clip || clip.writes !== write) {
          this._seams.remove(path);
          return;
        }
        const was = clip.file;
        clip.file = path;
        this._seams.show(clip.element, path);
        if (was) this._seams.remove(was);
      },
      () => {
        // a disk that took no file is a clip with no picture, which is what
        // a stream that has not ended shows anyway
      },
    );
  }

  close(id: number): void {
    const clip = this._clips.get(id);
    if (!clip) return;
    this._clips.delete(id);
    if (clip.file) {
      this._seams.show(clip.element, null);
      this._seams.remove(clip.file);
    }
  }

  dispose(): void {
    for (const id of [...this._clips.keys()]) this.close(id);
  }
}

/** Into its place by time: a packet of a time already held takes the old
 *  one's place, as an append over what is buffered does (MSE 3.5.8). */
function insert(packets: WebmPacket[], packet: WebmPacket): void {
  const last = packets[packets.length - 1];
  if (!last || packet.time > last.time) {
    packets.push(packet);
    return;
  }
  let low = 0;
  let high = packets.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (packets[mid].time < packet.time) low = mid + 1;
    else high = mid;
  }
  if (packets[low]?.time === packet.time) packets[low] = packet;
  else packets.splice(low, 0, packet);
}

function rangesOf(packets: WebmPacket[]): [number, number][] {
  if (!packets.length) return [];
  // a frame's length is the least between two: a gap is longer than any
  let frame = Infinity;
  for (let i = 1; i < packets.length; i += 1) {
    frame = Math.min(frame, packets[i].time - packets[i - 1].time);
  }
  if (frame === Infinity) frame = 0;
  const gap = frame * GAP_FRAMES;
  const ranges: [number, number][] = [];
  let start = packets[0].time;
  for (let i = 1; i < packets.length; i += 1) {
    const before = packets[i - 1].time;
    if (packets[i].time - before <= gap) continue;
    ranges.push([start, before + frame]);
    start = packets[i].time;
  }
  ranges.push([start, packets[packets.length - 1].time + frame]);
  return ranges;
}
