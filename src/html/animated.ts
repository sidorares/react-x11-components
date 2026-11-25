// An animated image — a GIF, a WebP or a PNG — as `<Html>` draws it: which frame
// shows when.
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
// The frames are made as they are first shown, on the format's canvas
// (`GifCanvas`, `WebPCanvas`, `ApngCanvas`), and kept
// — the same `Image` for a frame every time it comes round, so what is
// uploaded to the server or kept scaled for it is made once — where all of
// them come to no more than `KEPT_PIXELS`. Past that only the frame showing
// is, and the one it replaces is given up as it does.
import { ApngCanvas } from './apng.js';
import type { ApngFile, DecodePng } from './apng.js';
import { GifCanvas } from './gif.js';
import type { GifFile } from './gif.js';
import { WebPCanvas } from './webp.js';
import type { DecodeStill, WebPFile } from './webp.js';

/** What all of an animation's frames may come to, in pixels, and still be
 *  kept: 32 MB of RGBA, and as much again for each server it is drawn on. */
const KEPT_PIXELS = 1 << 23;

/** What a frame is made into: an ntk `Image`, from straight RGBA. */
export type MakeImage = (rgba: {
  width: number;
  height: number;
  data: Uint8Array;
}) => unknown;

/** What an animation is played from: its canvas, its frames' delays, how
 *  many times it plays, and the canvas once a frame is drawn. */
export interface AnimationSource {
  width: number;
  height: number;
  frames: readonly { delay: number }[];
  plays: number;
  at(index: number): Uint8Array;
}

/** A GIF's frames, drawn on a `GifCanvas`. */
export function gifAnimation(file: GifFile): AnimationSource {
  const canvas = new GifCanvas(file);
  return { ...file, at: (index) => canvas.at(index) };
}

/** An animated WebP's frames, drawn on a `WebPCanvas`, each decoded by
 *  `decode`. */
export function webpAnimation(
  file: WebPFile,
  decode: DecodeStill,
): AnimationSource {
  const canvas = new WebPCanvas(file, decode);
  return { ...file, at: (index) => canvas.at(index) };
}

/** An animated PNG's frames, drawn on an `ApngCanvas`, each decoded by
 *  `decode`. */
export function apngAnimation(
  file: ApngFile,
  decode: DecodePng,
): AnimationSource {
  const canvas = new ApngCanvas(file, decode);
  return { ...file, at: (index) => canvas.at(index) };
}

/** The frames made, and what each is a frame of (`AnimatedImage.reframe`). */
const FRAMES = new WeakMap<
  object,
  { animation: AnimatedImage; index: number }
>();

export class AnimatedImage {
  readonly width: number;
  readonly height: number;
  private readonly _file: AnimationSource;
  private readonly _make: MakeImage;
  /** When each frame starts within one play, and the play's length. */
  private readonly _starts: number[] = [];
  private readonly _duration: number;
  private readonly _keepAll: boolean;
  private readonly _images: unknown[] = [];
  /** The factor the frames in `_images` were made smaller by (`image`). */
  private _factor = 1;
  /** The longest side the frames have been drawn at, at most: what they
   *  are made no smaller than. */
  private _fit = 0;
  /** The time of the first frame's first showing: null until a paint asks. */
  private _start: number | null = null;

  constructor(file: AnimationSource, make: MakeImage) {
    this._file = file;
    this._make = make;
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

  /**
   * Frame `index` as an image. Where `fit` says the longest side it is drawn
   * at, and the frames are too many to be kept, it is made smaller by the
   * whole factor that leaves it no smaller than that (`reduced`): a GIF of
   * 1920 pixels drawn at 480 was 14 MB sent to the display server and read
   * whole by every draw, for each frame, and is 0.9 MB so.
   */
  image(index: number, fit = 0): unknown {
    this._fit = Math.max(this._fit, fit);
    const factor = this._keepAll
      ? 1
      : factorFor(this.width, this.height, this._fit);
    if (factor !== this._factor) {
      this.destroy();
      this._factor = factor;
    }
    const kept = this._images[index];
    if (kept) return kept;
    const full = this._file.at(index);
    const data =
      factor === 1
        ? full.slice()
        : reduced(full, this.width, this.height, factor);
    const image = this._make({
      width: Math.floor(this.width / factor),
      height: Math.floor(this.height / factor),
      data,
    });
    if (!this._keepAll) this.destroy();
    this._images[index] = image;
    if (image && typeof image === 'object') {
      FRAMES.set(image, { animation: this, index });
    }
    return image;
  }

  /** `image`, if it is a frame of an animation, as it is for a draw whose
   *  longest side is `fit`: the one asked for already, or a smaller one
   *  made, and then the one every frame after it is. Any other image as
   *  it is. */
  static reframe(image: unknown, fit: number): unknown {
    const frame =
      image && typeof image === 'object' ? FRAMES.get(image) : undefined;
    if (!frame) return image;
    return frame.animation.image(frame.index, fit);
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

/** The whole number to make an image of `width` by `height` smaller by, so
 *  that it is still no smaller than `fit` on its longest side: 1 for none
 *  asked, and for less than a halving. */
function factorFor(width: number, height: number, fit: number): number {
  if (!(fit > 0)) return 1;
  const side = Math.max(width, height);
  return Math.max(1, Math.min(8, Math.floor(side / Math.ceil(fit))));
}

/**
 * `data`, RGBA of `width` by `height`, made `factor` times smaller on each
 * side: each pixel is the mean of a block of two by two taken from the
 * middle of the `factor` by `factor` it stands for — all of it for a
 * factor of 2, and a sample of it above that, which reads a sixteenth of
 * the pixels of a factor of 4 where the mean of the whole block reads all.
 */
function reduced(
  data: Uint8Array,
  width: number,
  height: number,
  factor: number,
): Uint8Array {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint8Array(w * h * 4);
  const lead = Math.max(0, (factor >> 1) - 1);
  // a pixel a word, where the data is aligned to read them so: the four
  // channels of two pixels are summed at once, in the two halves of a word
  // each wide enough for the sum of four bytes
  const aligned = (data.byteOffset & 3) === 0;
  if (!aligned) return reducedBytes(data, width, w, h, factor, lead, out);
  const from = new Uint32Array(data.buffer, data.byteOffset, width * height);
  const to = new Uint32Array(out.buffer, 0, w * h);
  const lowMask = 0x00ff00ff;
  for (let y = 0; y < h; y += 1) {
    const row0 = (y * factor + lead) * width + lead;
    const row1 = row0 + width;
    let o = y * w;
    for (let x = 0; x < w; x += 1) {
      const i = x * factor;
      const a = from[row0 + i];
      const b = from[row0 + i + 1];
      const c = from[row1 + i];
      const d = from[row1 + i + 1];
      // channels 0 and 2, and 1 and 3, apart: each sum is under 1024
      const even =
        (a & lowMask) + (b & lowMask) + (c & lowMask) + (d & lowMask);
      const odd =
        ((a >>> 8) & lowMask) +
        ((b >>> 8) & lowMask) +
        ((c >>> 8) & lowMask) +
        ((d >>> 8) & lowMask);
      // a quarter of each: shifted two, and cut to the byte it stays in
      to[o] = (((even >>> 2) & lowMask) | (((odd >>> 2) & lowMask) << 8)) >>> 0;
      o += 1;
    }
  }
  return out;
}

/** `reduced`, a byte at a time: for data a word cannot be read from, and a
 *  machine whose words are the other way round. */
function reducedBytes(
  data: Uint8Array,
  width: number,
  w: number,
  h: number,
  factor: number,
  lead: number,
  out: Uint8Array,
): Uint8Array {
  for (let y = 0; y < h; y += 1) {
    const row0 = (y * factor + lead) * width;
    const row1 = row0 + width;
    let o = y * w * 4;
    for (let x = 0; x < w; x += 1) {
      const a = (row0 + x * factor + lead) * 4;
      const b = (row1 + x * factor + lead) * 4;
      for (let k = 0; k < 4; k += 1) {
        out[o + k] =
          (data[a + k] + data[a + 4 + k] + data[b + k] + data[b + 4 + k]) >> 2;
      }
      o += 4;
    }
  }
  return out;
}
