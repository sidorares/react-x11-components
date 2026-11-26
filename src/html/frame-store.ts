// Frames a WebGL context drew, kept in the process that owns the GPU until
// the canvas they are for takes them (`takeFrame`). A stage no element shows
// hands its picture to the canvases it appears in, from a worker's thread or
// the page's, and a frame of a pane at 2x is 13 MB: through a string, a JSON
// message and a decode at each end it was ten passes over every byte, and a
// glass panel drew at a few frames a second. A frame crosses a thread as its
// number here, and the pixels are moved once.
//
// Nothing here knows who asked: a number is the process's, and what holds one
// that nobody takes is bounded (`MOST_BYTES`), as a canvas that was never
// shown, or a bitmap nobody closed, would otherwise hold them for good.

/** A frame: straight RGBA, its top row first. */
export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** The most a process keeps of frames nobody has taken. */
const MOST_BYTES = 128 * 1024 * 1024;

const frames = new Map<number, Frame>();
/** What a frame another thread made tells it when it is gone, taken or not:
 *  that thread makes no more until the page has what it sent. */
const acks = new Map<number, () => void>();

function forget(id: number): void {
  const ack = acks.get(id);
  if (ack) {
    acks.delete(id);
    ack();
  }
}
let next = 1;
let held = 0;

/** Where this process's numbers start, for a thread that makes frames the
 *  page process will be handed (`keepFrameAs`): two threads' numbers must not
 *  meet in it. */
export function setFrameIdBase(base: number): void {
  next = base;
}

/** A frame another thread made, kept under the number it knew it by. */
export function keepFrameAs(id: number, frame: Frame, ack?: () => void): void {
  frames.set(id, frame);
  if (ack) acks.set(id, ack);
  held += frame.data.byteLength;
  for (const [old, f] of frames) {
    if (held <= MOST_BYTES || old === id) break;
    frames.delete(old);
    held -= f.data.byteLength;
    forget(old);
  }
}

/** A frame's number: it is kept until taken, discarded, or pushed out by
 *  newer ones past `MOST_BYTES`. */
export function keepFrame(frame: Frame): number {
  const id = next;
  next += 1;
  frames.set(id, frame);
  held += frame.data.byteLength;
  for (const [old, f] of frames) {
    if (held <= MOST_BYTES || old === id) break;
    frames.delete(old);
    held -= f.data.byteLength;
    forget(old);
  }
  return id;
}

/** The frame, and no longer kept: its pixels are the taker's. */
export function takeFrame(id: number): Frame | null {
  const frame = frames.get(id) ?? null;
  if (frame) {
    frames.delete(id);
    held -= frame.data.byteLength;
    forget(id);
  }
  return frame;
}

/** The frame, left where it is: for a read that is not a taking. */
export function peekFrame(id: number): Frame | null {
  return frames.get(id) ?? null;
}

/** Let a frame go that nobody will take. */
export function discardFrame(id: number): void {
  takeFrame(id);
}

/** Where a frame differs from the one before it, of the same size: the box
 *  of the pixels that moved, `[x0, y0, x1, y1]`, or null where none did, and
 *  whether any pixel's alpha did. A glass panel's stage is mostly what it was,
 *  and what a frame is shown from is only what moved (`CanvasPixels.pending`). */
export function diffFrames(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  height: number,
): { rect: [number, number, number, number] | null; alpha: boolean } {
  if (
    before.length !== after.length ||
    !LITTLE_ENDIAN ||
    (before.byteOffset & 3) !== 0 ||
    (after.byteOffset & 3) !== 0
  ) {
    return { rect: [0, 0, width, height], alpha: alphaChanged(before, after) };
  }
  const a = new Uint32Array(
    before.buffer,
    before.byteOffset,
    before.length >> 2,
  );
  const b = new Uint32Array(after.buffer, after.byteOffset, after.length >> 2);
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  let alpha = false;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1) {
      const d = a[row + x] ^ b[row + x];
      if (d !== 0) {
        if (first < 0) first = x;
        last = x;
        if ((d & 0xff000000) !== 0) alpha = true;
      }
    }
    if (first < 0) continue;
    if (top < 0) top = y;
    bottom = y;
    if (first < left) left = first;
    if (last > right) right = last;
  }
  return {
    rect: top < 0 ? null : [left, top, right + 1, bottom + 1],
    alpha,
  };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Whether an alpha channel of one picture differs from another's of the
 *  same size: four bytes a step, which is most of what makes a frame at 2x
 *  cheap to compare where it has not moved. */
export function alphaChanged(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
): boolean {
  if (before.length !== after.length) return true;
  if (
    LITTLE_ENDIAN &&
    (before.byteOffset & 3) === 0 &&
    (after.byteOffset & 3) === 0
  ) {
    const a = new Uint32Array(
      before.buffer,
      before.byteOffset,
      before.length >> 2,
    );
    const b = new Uint32Array(
      after.buffer,
      after.byteOffset,
      after.length >> 2,
    );
    for (let i = 0; i < a.length; i += 1) {
      if (((a[i] ^ b[i]) & 0xff000000) !== 0) return true;
    }
    return false;
  }
  for (let i = 3; i < after.length; i += 4) {
    if (after[i] !== before[i]) return true;
  }
  return false;
}
