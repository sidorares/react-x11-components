// Drawing an image, however large it is drawn and wherever it lies.
//
// An X request carries a place in sixteen signed bits and a size in sixteen
// unsigned ones, and ntk hands `drawImage` both as they are: a background
// sized 70,000px across, or one that starts 40,000px to the left, threw out
// of the request's encoder, and out of the paint, which left the document
// blank. So a draw a request cannot carry is cut here to the surface it is
// drawn on, which is all of it that can show, and the part of the image it
// reads is cut to match, so each pixel reads what it would have. `<Map>`
// cuts its tiles for the same reason (`MapViewNode._composite`).
//
// A draw a request can carry goes to the context as it came.

import * as ntk from 'react-x11/ntk';

/** The longest side a server makes a pixmap of, and so the longest of a
 *  surface or of an image's upload: its regions are in signed shorts. */
export const PIXMAP_SIDE = 32767;

/** The furthest from the corner a request can place something, each way,
 *  and the largest size it can give it. */
const PLACE_LEAST = -32768;
const PLACE_MOST = 32767;
const SIZE_MOST = 65535;

/** How much of an image too long to upload is uploaded at a time
 *  (`pieceOf`), and how many such pieces are kept of one. */
const PIECE = 8192;
const PIECES_KEPT = 8;

/** What an image too long to upload is made smaller to (`smaller`). */
const SMALLER = 16384;

/** The slice of a context a draw asks. */
export interface ImageContext {
  drawImage?(image: unknown, ...args: number[]): void;
  getTransform?(): {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  };
  /** True on the native backends, whose contexts take a place and a size as
   *  they are and draw what of them shows. */
  readonly scalesText?: boolean;
}

/** A rectangle, as `drawImage` takes one. */
type Quad = [x: number, y: number, w: number, h: number];

/** Decoded pixels, as ntk's `Image` keeps them: straight RGBA. */
interface Pixels {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Whether a request carries this place and this size. A number that is
 *  none is carried no more than one too large is. */
function carried(x: number, y: number, w: number, h: number): boolean {
  return (
    x >= PLACE_LEAST &&
    x <= PLACE_MOST &&
    y >= PLACE_LEAST &&
    y <= PLACE_MOST &&
    w <= SIZE_MOST &&
    h <= SIZE_MOST
  );
}

/** Whether an image is too long a side to be uploaded whole. */
export function tooLong(image: unknown): boolean {
  const { width, height } = image as { width?: unknown; height?: unknown };
  return (
    (typeof width === 'number' && width > PIXMAP_SIDE) ||
    (typeof height === 'number' && height > PIXMAP_SIDE)
  );
}

/** `ctx.drawImage(image, x, y)`, wherever that is. */
export function drawImageAt(
  ctx: ImageContext,
  image: unknown,
  x: number,
  y: number,
): void {
  if (carried(x, y, 0, 0) && !tooLong(image)) ctx.drawImage!(image, x, y);
  else {
    const { width, height } = image as { width: number; height: number };
    drawCut(ctx, image, [0, 0, width, height], [x, y, width, height]);
  }
}

/** `ctx.drawImage(image, x, y, w, h)`, however large that is. */
export function drawImageSized(
  ctx: ImageContext,
  image: unknown,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (carried(x, y, w, h) && !tooLong(image)) {
    ctx.drawImage!(image, x, y, w, h);
    return;
  }
  const own = image as { width?: unknown; height?: unknown };
  if (typeof own.width !== 'number' || typeof own.height !== 'number') {
    ctx.drawImage!(image, x, y, w, h);
    return;
  }
  drawCut(ctx, image, [0, 0, own.width, own.height], [x, y, w, h]);
}

/** `ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h)`, however large. */
export function drawImagePart(
  ctx: ImageContext,
  image: unknown,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (carried(x, y, w, h) && !tooLong(image)) {
    ctx.drawImage!(image, sx, sy, sw, sh, x, y, w, h);
  } else drawCut(ctx, image, [sx, sy, sw, sh], [x, y, w, h]);
}

/**
 * The part of a draw that shows on the surface it is drawn on. Cut only for
 * a context that says how large it is and draws where it is told to: ntk's,
 * with no transform on it. Under one, ntk works out the pixels the draw
 * reaches and clamps them itself, and a native context takes any numbers.
 */
function drawCut(
  ctx: ImageContext,
  image: unknown,
  source: Quad,
  target: Quad,
): void {
  if (ctx.scalesText === true) {
    ctx.drawImage!(image, ...source, ...target);
    return;
  }
  let [sx, sy, sw, sh] = source;
  let [x, y, w, h] = target;
  const { width, height } = ctx as { width?: unknown; height?: unknown };
  const m = ctx.getTransform?.();
  const level =
    !m || (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && !m.e && !m.f);
  if (level && typeof width === 'number' && typeof height === 'number') {
    const left = Math.max(x, 0);
    const top = Math.max(y, 0);
    const right = Math.min(x + w, width);
    const bottom = Math.min(y + h, height);
    if (!(right > left && bottom > top)) return;
    // The image pixels a pixel of the draw steps across: 1 where the image
    // is drawn at its own size, and the part is as large as what it reads.
    const kx = sw / w;
    const ky = sh / h;
    sx += (left - x) * kx;
    sy += (top - y) * ky;
    x = left;
    y = top;
    w = right - left;
    h = bottom - top;
    sw = w * kx;
    sh = h * ky;
  }
  if (tooLong(image) && isPixels(image)) {
    const piece = pieceOf(image, sx, sy, sw, sh);
    if (piece) {
      ctx.drawImage!(
        piece.image,
        sx - piece.x,
        sy - piece.y,
        sw,
        sh,
        x,
        y,
        w,
        h,
      );
      return;
    }
    const less = smaller(image);
    const kx = less.width / image.width;
    const ky = less.height / image.height;
    ctx.drawImage!(less, sx * kx, sy * ky, sw * kx, sh * ky, x, y, w, h);
    return;
  }
  ctx.drawImage!(image, sx, sy, sw, sh, x, y, w, h);
}

function isPixels(image: unknown): image is Pixels {
  const { width, height, data } = image as Partial<Pixels>;
  return (
    (data instanceof Uint8Array || data instanceof Uint8ClampedArray) &&
    data.length === width! * height! * 4
  );
}

function imageOf(pixels: Pixels): unknown {
  return new ntk.Image(pixels as never);
}

/** The pieces kept of an image too long to upload, by where they start and
 *  end, the last drawn last. */
const PIECES = new WeakMap<object, Map<string, unknown>>();

/**
 * The piece of an image too long to upload that a draw reads, with the
 * pixel round it a draw that scales filters across, as an image of its own
 * and where its corner is in the whole. Whole blocks of `PIECE` pixels, so
 * the next frame of a scroll reads the piece this one did. Null where the
 * piece is itself too long.
 */
function pieceOf(
  image: Pixels,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): { image: unknown; x: number; y: number } | null {
  const x0 = Math.max(0, Math.floor((sx - 1) / PIECE) * PIECE);
  const y0 = Math.max(0, Math.floor((sy - 1) / PIECE) * PIECE);
  const x1 = Math.min(image.width, Math.ceil((sx + sw + 1) / PIECE) * PIECE);
  const y1 = Math.min(image.height, Math.ceil((sy + sh + 1) / PIECE) * PIECE);
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(width > 0 && height > 0)) return null;
  if (width > PIXMAP_SIDE || height > PIXMAP_SIDE) return null;
  let kept = PIECES.get(image);
  if (!kept) PIECES.set(image, (kept = new Map()));
  const key = `${x0},${y0},${x1},${y1}`;
  let piece = kept.get(key);
  if (piece) kept.delete(key);
  else {
    const data = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row += 1) {
      const from = ((y0 + row) * image.width + x0) * 4;
      data.set(image.data.subarray(from, from + width * 4), row * width * 4);
    }
    piece = imageOf({ width, height, data });
    if (kept.size >= PIECES_KEPT) {
      const [oldest, old] = kept.entries().next().value!;
      kept.delete(oldest);
      (old as { destroy?(): void }).destroy?.();
    }
  }
  kept.set(key, piece);
  return { image: piece, x: x0, y: y0 };
}

const SMALLER_KEPT = new WeakMap<object, Pixels>();

/** An image too long to upload, made no longer than `SMALLER`: what is
 *  drawn of one where more of it shows than a piece holds, at a fraction of
 *  its size. */
function smaller(image: Pixels): Pixels {
  let made = SMALLER_KEPT.get(image);
  if (!made) {
    const width = Math.min(SMALLER, image.width);
    const height = Math.min(SMALLER, image.height);
    const data = resampled(
      image.data,
      image.width,
      image.height,
      width,
      height,
    );
    made = imageOf({ width, height, data }) as Pixels;
    SMALLER_KEPT.set(image, made);
  }
  return made;
}

/** Straight RGBA at another size, the nearest pixel each. */
export function resampled(
  src: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  if (w === width && h === height) return new Uint8ClampedArray(src);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / width));
      const i = (y * width + x) * 4;
      const j = (sy * w + sx) * 4;
      out[i] = src[j];
      out[i + 1] = src[j + 1];
      out[i + 2] = src[j + 2];
      out[i + 3] = src[j + 3];
    }
  }
  return out;
}
