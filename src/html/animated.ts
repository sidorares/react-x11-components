// An animated GIF, as `<Html>` draws it: which frame shows when.
//
// A browser plays an animated image wherever it is drawn — an `<img>`, a
// background, a list marker — and every place that draws one URL shows the
// same frame, since the animation is the image's and not the element's: it
// starts when the image is first drawn and runs on from there. So one of
// these is kept per image by the resource store, its clock started by the
// first paint that asks for a frame (`indexAt`), and the element asks it
// when the frame it painted gives way to the next (`nextChange`) — a timer
// per document, not per image, and none once every animation drawn has
// played its last loop or nothing that draws one is painted any more.
//
// The frames are made as they are first shown, on a `GifCanvas`, and kept
// — the same `Image` for a frame every time it comes round, so what is
// uploaded to the server or kept scaled for it is made once — where all of
// them come to no more than `KEPT_PIXELS`. Past that only the frame showing
// is, and the one it replaces is given up as it does.
import { GifCanvas } from './gif.js';
import type { GifFile } from './gif.js';

/** What all of an animation's frames may come to, in pixels, and still be
 *  kept: 32 MB of RGBA, and as much again for each server it is drawn on. */
const KEPT_PIXELS = 1 << 23;

/** What a frame is made into: an ntk `Image`, from straight RGBA. */
export type MakeImage = (rgba: {
  width: number;
  height: number;
  data: Uint8Array;
}) => unknown;

export class AnimatedImage {
  readonly width: number;
  readonly height: number;
  private readonly _file: GifFile;
  private readonly _make: MakeImage;
  private readonly _canvas: GifCanvas;
  /** When each frame starts within one play, and the play's length. */
  private readonly _starts: number[] = [];
  private readonly _duration: number;
  private readonly _keepAll: boolean;
  private readonly _images: unknown[] = [];
  /** The time of the first frame's first showing: null until a paint asks. */
  private _start: number | null = null;

  constructor(file: GifFile, make: MakeImage) {
    this._file = file;
    this._make = make;
    this._canvas = new GifCanvas(file);
    this.width = file.width;
    this.height = file.height;
    let t = 0;
    for (const frame of file.frames) {
      this._starts.push(t);
      t += frame.delay;
    }
    this._duration = t;
    this._keepAll =
      file.width * file.height * file.frames.length <= KEPT_PIXELS;
  }

  /** The frame showing at `now`, in milliseconds on the document's clock.
   *  The first question starts the clock. */
  indexAt(now: number): number {
    const t = this._elapsed(now);
    const frames = this._file.frames.length;
    if (t >= this._duration * this._file.plays) return frames - 1;
    const within = t % this._duration;
    let index = 0;
    while (index + 1 < frames && this._starts[index + 1] <= within) index += 1;
    return index;
  }

  /** When the frame showing at `now` gives way to the next: null once the
   *  last play is over, and the last frame shows for good. */
  nextChange(now: number): number | null {
    const t = this._elapsed(now);
    if (t >= this._duration * this._file.plays) return null;
    const play = Math.floor(t / this._duration);
    const index = this.indexAt(now);
    const end = this._starts[index + 1] ?? this._duration;
    return this._start! + play * this._duration + end;
  }

  /** Frame `index` as an image. */
  image(index: number): unknown {
    const kept = this._images[index];
    if (kept) return kept;
    const data = this._canvas.at(index).slice();
    const image = this._make({ width: this.width, height: this.height, data });
    if (!this._keepAll) this.destroy();
    this._images[index] = image;
    return image;
  }

  /** Give up the frames made, and their copies on any server. A frame
   *  asked for again is made again. */
  destroy(): void {
    for (const image of this._images) {
      (image as { destroy?(): void } | undefined)?.destroy?.();
    }
    this._images.length = 0;
  }

  private _elapsed(now: number): number {
    this._start ??= now;
    return Math.max(0, now - this._start);
  }
}
