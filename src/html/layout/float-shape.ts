// A float's float area (CSS Shapes 1, 6–7): what the lines beside a float
// go around, where `shape-outside` gives it one in place of its margin box.
//
// The area is laid down as polygons in the float's own space, from its
// margin box's top left — a rounded box's corners and a circle's arc cut
// into chords as `clip-path` cuts them — and grown by `shape-margin`. A line
// asks for the area's horizontal extent over the band it takes up
// (`extent`), and the float narrows it by that extent's far side, or not at
// all where the area leaves the band empty. The area is the shape clipped to
// the margin box (6.1), so the extent is too.
//
// Only lines go around it: a float placed beside another, and a box with a
// formatting context of its own, keep to the margin box (CSS Shapes 1, 1).

import type { Box } from './boxes.js';
import { resolve } from '../css/values.js';
import type { Len } from '../css/values.js';
import { shapePolygons } from '../css/basic-shape.js';
import { gradientOf, urlOf } from '../css/style.js';
import type { BackgroundImage, ClipPath } from '../css/style.js';
import { alphaOf as colorAlpha } from '../css/values.js';
import {
  cornersFor,
  cornersOf,
  insetCorners,
  lineAngle,
  radialShape,
  spreadCorners,
  stopOffsets,
} from '../paint.js';
import type { Corners } from '../paint.js';

export interface FloatShape {
  /** The area's horizontal extent over `top` to `bottom`, from the margin
   *  box's left; null where it has nothing there. */
  extent(top: number, bottom: number): readonly [number, number] | null;
  /** The area's own top and bottom, from the margin box's top: where the
   *  room beside it can change. */
  readonly top: number;
  readonly bottom: number;
}

/** How far a line's band is taken in from its top and its bottom: an
 *  area that starts where a line ends, or ends where it starts, is not
 *  beside it. */
const OPEN = 1e-7;

/** How far a chord of the area's curves strays inside them: a line's
 *  place comes of the extent, and is snapped to the pixel it falls
 *  nearest, so a tenth of a pixel moved some lines a whole one. */
const FINE = 0.002;

/**
 * A float's area where `shape-outside` gives it one, or null where it keeps
 * its margin box: no shape, a shape nothing can be laid down for, or one
 * this layout does not read (an image whose pixels are not in, a flow that
 * is not horizontal). `containingWidth` is what `shape-margin`'s percentage
 * is of; `images` hands over an image's pixels by its URL.
 */
export function floatShapeOf(
  box: Box,
  containingWidth: number,
  images?: ShapeImageSource | null,
): FloatShape | null {
  const style = box.style;
  const shape = style.shapeOutside;
  if (!shape) return null;
  if (style.writingMode && style.writingMode !== 'horizontal-tb') return null;
  const margin = Math.max(0, resolve(style.shapeMargin, containingWidth));
  const width = box.width + box.marginLeft + box.marginRight;
  const height = box.height + box.marginTop + box.marginBottom;
  // a float is placed again at every layout, and its area is the same
  // while its box and its style are: a gradient is a pixel at a time
  const url = urlOf(style.shapeImage);
  const key = [
    box.width,
    box.height,
    box.marginTop,
    box.marginRight,
    box.marginBottom,
    box.marginLeft,
    box.borderTop,
    box.borderRight,
    box.borderBottom,
    box.borderLeft,
    box.padTop,
    box.padRight,
    box.padBottom,
    box.padLeft,
    margin,
    url !== null && !!images?.(url),
  ].join();
  const kept = KEPT.get(box);
  if (kept && kept.style === style && kept.key === key) return kept.shape;
  const made = makeShape(box, shape, images ?? null, margin, width, height);
  KEPT.set(box, { style, key, shape: made });
  return made;
}

/** Each float's area, by what it was made from. */
const KEPT = new WeakMap<
  Box,
  { style: object; key: string; shape: FloatShape | null }
>();

function makeShape(
  box: Box,
  shape: ClipPath | string,
  images: ShapeImageSource | null,
  margin: number,
  width: number,
  height: number,
): FloatShape | null {
  const style = box.style;
  let polys: number[][] | null;
  if (typeof shape === 'string') {
    polys = style.shapeImage
      ? imagePolygons(box, style.shapeImage, style.shapeImageThreshold, images)
      : null;
  } else {
    polys = shapeAreaPolygons(box, shape);
  }
  if (!polys) return null;
  return new PolygonArea(polys, margin, width, height);
}

/** Where a reference box is, from the margin box's top left. */
function referenceBox(
  box: Box,
  which: ClipPath['box'],
): {
  x: number;
  y: number;
  w: number;
  h: number;
  insets: [number, number, number, number];
} {
  const ml = box.marginLeft;
  const mt = box.marginTop;
  let t = 0;
  let r = 0;
  let b = 0;
  let l = 0;
  if (which === 'margin-box') {
    t = -box.marginTop;
    r = -box.marginRight;
    b = -box.marginBottom;
    l = -box.marginLeft;
  } else if (which === 'padding-box' || which === 'content-box') {
    t = box.borderTop;
    r = box.borderRight;
    b = box.borderBottom;
    l = box.borderLeft;
    if (which === 'content-box') {
      t += box.padTop ?? 0;
      r += box.padRight ?? 0;
      b += box.padBottom ?? 0;
      l += box.padLeft ?? 0;
    }
  }
  return {
    x: ml + l,
    y: mt + t,
    w: Math.max(0, box.width - l - r),
    h: Math.max(0, box.height - t - b),
    insets: [t, r, b, l],
  };
}

/** A basic shape, or a box named alone, as polygons from the margin box's
 *  top left (CSS Shapes 1, 3.1 and 3.2). */
function shapeAreaPolygons(box: Box, path: ClipPath): number[][] | null {
  const ref = referenceBox(box, path.box);
  const { x: x0, y: y0, w: width, h: height } = ref;
  if (path.shape === 'url') return null;
  if (path.shape === 'polygon') {
    const points = path.points ?? [];
    const poly: number[] = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
      poly.push(
        x0 + resolve(points[i], width),
        y0 + resolve(points[i + 1], height),
      );
    }
    return [poly];
  }
  if (path.shape === 'basic') {
    if (!path.basic) return null;
    const laid = shapePolygons(path.basic, width, height, FINE);
    return laid.polys.map((p) => p.map((v, i) => v + (i % 2 ? y0 : x0)));
  }
  if (path.shape === null) {
    // the box alone, its corners as the element's border-radius rounds
    // them: in from the border edge for the inner boxes, out from it, as a
    // shadow's spread is, for the margin box (3.2)
    const corners = cornersOf(box.style, box.width, box.height);
    let c: Corners | null = null;
    if (corners) {
      const [t, r, b, l] = ref.insets;
      c =
        path.box === 'margin-box'
          ? spreadCorners(corners, box.width, box.height, -t, -r, -b, -l)
          : insetCorners(corners, t, r, b, l);
    }
    return [roundedRect(x0, y0, width, height, c)];
  }
  const [a, b, c, d] = path.lengths as readonly [Len, Len, Len, Len];
  let top = 0;
  let right = 0;
  let bottom = 0;
  let left = 0;
  if (path.shape === 'inset') {
    top = resolve(a, height);
    right = resolve(b, width);
    bottom = resolve(c, height);
    left = resolve(d, width);
    if (left + right > width && left > 0 && right > 0) {
      const f = Math.max(0, width) / (left + right);
      left *= f;
      right *= f;
    }
    if (top + bottom > height && top > 0 && bottom > 0) {
      const f = Math.max(0, height) / (top + bottom);
      top *= f;
      bottom *= f;
    }
  } else if (path.shape === 'rect') {
    const auto = (v: Len) => typeof v === 'string' && v === 'auto';
    top = auto(a) ? 0 : resolve(a, height);
    left = auto(d) ? 0 : resolve(d, width);
    right = auto(b) ? 0 : width - Math.max(left, resolve(b, width));
    bottom = auto(c) ? 0 : height - Math.max(top, resolve(c, height));
  } else if (path.shape === 'xywh') {
    left = resolve(a, width);
    top = resolve(b, height);
    right = width - left - Math.max(0, resolve(c, width));
    bottom = height - top - Math.max(0, resolve(d, height));
  }
  const w = Math.max(0, width - left - right);
  const h = Math.max(0, height - top - bottom);
  const radii = path.radii
    ? cornersFor(path.radii, path.radiiY, width, height, w, h)
    : null;
  return [roundedRect(x0 + left, y0 + top, w, h, radii)];
}

/** A rectangle with its corners rounded as polygon, clockwise from its top
 *  left; each arc cut into chords no further than `FINE` from
 *  it. A square corner is its point. */
function roundedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  c: Corners | null,
): number[] {
  const out: number[] = [];
  // corners: 0 top left, 1 top right, 2 bottom right, 3 bottom left
  const centres: [number, number, number, number, number][] = [];
  for (let i = 0; i < 4; i += 1) {
    const rx = c ? c.x[i] : 0;
    const ry = c ? c.y[i] : 0;
    const cx = i === 0 || i === 3 ? x + rx : x + w - rx;
    const cy = i < 2 ? y + ry : y + h - ry;
    // the angle the arc starts at, going clockwise in screen space
    const from = [Math.PI, 1.5 * Math.PI, 0, 0.5 * Math.PI][i];
    centres.push([cx, cy, rx, ry, from]);
  }
  for (const [cx, cy, rx, ry, from] of centres) {
    if (!(rx > 0 && ry > 0)) {
      out.push(cx, cy);
      continue;
    }
    const r = Math.max(rx, ry);
    const step = 2 * Math.acos(Math.max(-1, 1 - FINE / r));
    const n = Math.min(1024, Math.max(2, Math.ceil(Math.PI / 2 / (step || 1))));
    for (let k = 0; k <= n; k += 1) {
      const t = from + (k / n) * (Math.PI / 2);
      out.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
    }
  }
  return out;
}

/** The pixels of an image `shape-outside` names, by its URL, as a float's
 *  layout is handed them: RGBA, a row at a time, at the image's natural
 *  size. Null where they are not in yet, or never will be. */
export type ShapeImageSource = (url: string) =>
  | { width: number; height: number; data: ArrayLike<number> }
  /** A drawing, which has no pixels: drawn `w` by `h` on the context it
   *  is handed, which records what it fills (`recordFills`). */
  | { draw(ctx: unknown, w: number, h: number): void }
  | null;

/** The source a tree's floats read their images from, which the element
 *  that lays the tree out hands in (`setShapeImages`). */
const SOURCES = new WeakMap<object, ShapeImageSource>();

/** Hand a tree's layout the images its floats' shapes name. */
export function setShapeImages(tree: object, source: ShapeImageSource): void {
  SOURCES.set(tree, source);
}

/** The images a tree's floats' shapes are read from, or none. */
export function shapeImagesOf(tree: object): ShapeImageSource | null {
  return SOURCES.get(tree) ?? null;
}

/** An alpha raster: `width` by `height`, one byte a pixel. */
interface Alpha {
  width: number;
  height: number;
  alpha: Uint8Array;
}

/**
 * An image's or a gradient's alpha (CSS Shapes 1, 3.3), at the size of the
 * content box it is drawn in: an image's own pixels, stretched over it as
 * a replaced element's would be; a gradient's, a pixel at a time, worked
 * out from its line or its rings. Null where an image is not in.
 */
function alphaOf(
  box: Box,
  image: BackgroundImage,
  w: number,
  h: number,
  source: ShapeImageSource | null,
): Alpha | null {
  const url = urlOf(image);
  if (url !== null) {
    const img = source?.(url);
    if (!img || 'draw' in img || !(img.width > 0 && img.height > 0))
      return null;
    const alpha = new Uint8Array(img.width * img.height);
    for (let i = 0; i < alpha.length; i += 1) alpha[i] = img.data[4 * i + 3];
    return { width: img.width, height: img.height, alpha };
  }
  const gradient = gradientOf(image);
  if (!gradient || !(w > 0 && h > 0)) return null;
  const current = box.style.color;
  const alphas = gradient.stops.map(
    (stop) =>
      255 * colorAlpha(stop.color === 'currentColor' ? current : stop.color),
  );
  const alpha = new Uint8Array(w * h);
  let at: number[];
  let along: (x: number, y: number) => number;
  if (gradient.kind === 'linear') {
    const angle = lineAngle(gradient, w, h);
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    const length = Math.abs(w * dx) + Math.abs(h * dy);
    at = stopOffsets(gradient.stops, length);
    // a pixel's fraction of the way along the line, from its centre
    along = (x, y) =>
      length > 0 ? ((x - w / 2) * dx + (y - h / 2) * dy) / length + 0.5 : 0;
  } else {
    const { cx, cy, rx, ry } = radialShape(gradient, w, h);
    if (!(rx > 0 && ry > 0)) {
      alpha.fill(alphas[alphas.length - 1]);
      return { width: w, height: h, alpha };
    }
    at = stopOffsets(gradient.stops, rx);
    along = (x, y) => Math.hypot((x - cx) / rx, (y - cy) / ry);
  }
  const first = at[0];
  const last = at[at.length - 1];
  const period = last - first;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let t = along(x + 0.5, y + 0.5);
      if (gradient.repeating && period > 0) {
        t = first + ((((t - first) % period) + period) % period);
      }
      alpha[y * w + x] = Math.round(stopAlpha(at, alphas, t));
    }
  }
  return { width: w, height: h, alpha };
}

/** The alpha at `t` along stops `at` (CSS Images 3, 3.5.1): the first's
 *  before it, the last's after it, and between two, what lies between
 *  them in proportion, or the later where they are at one place. */
function stopAlpha(at: number[], alphas: number[], t: number): number {
  if (t <= at[0]) return alphas[0];
  for (let i = 1; i < at.length; i += 1) {
    if (t < at[i]) {
      const span = at[i] - at[i - 1];
      if (!(span > 0)) return alphas[i];
      const f = (t - at[i - 1]) / span;
      return alphas[i - 1] + (alphas[i] - alphas[i - 1]) * f;
    }
  }
  return alphas[alphas.length - 1];
}

/**
 * An image's area (CSS Shapes 1, 3.3): the pixels whose alpha is over the
 * threshold, as a rectangle a run of them, in the content box.
 */
function imagePolygons(
  box: Box,
  image: BackgroundImage,
  threshold: number,
  source: ShapeImageSource | null,
): number[][] | null {
  const ref = referenceBox(box, 'content-box');
  const w = Math.round(ref.w);
  const h = Math.round(ref.h);
  if (!(w > 0 && h > 0)) return [];
  const url = urlOf(image);
  const drawn = url !== null ? source?.(url) : null;
  if (drawn && 'draw' in drawn) {
    // a drawing's area is what it fills, where the fill is opaque enough
    const polys = recordFills(
      (ctx) => drawn.draw(ctx, ref.w, ref.h),
      threshold,
    );
    return polys.map((p) => p.map((v, i) => v + (i % 2 ? ref.y : ref.x)));
  }
  const img = alphaOf(box, image, w, h, source);
  if (!img) return null;
  const limit = threshold * 255;
  const polys: number[][] = [];
  const sx = ref.w / img.width;
  const sy = ref.h / img.height;
  for (let row = 0; row < img.height; row += 1) {
    let start = -1;
    for (let col = 0; col <= img.width; col += 1) {
      const a = col < img.width ? img.alpha[row * img.width + col] : 0;
      const over = a > limit;
      if (over && start < 0) start = col;
      if (!over && start >= 0) {
        const x0 = ref.x + start * sx;
        const x1 = ref.x + col * sx;
        const y0 = ref.y + row * sy;
        const y1 = y0 + sy;
        polys.push([x0, y0, x1, y0, x1, y1, x0, y1]);
        start = -1;
      }
    }
  }
  return polys;
}

/**
 * What a drawing fills, as polygons in the space it is drawn in: a context
 * that keeps the paths it is asked to fill, through the transform in force,
 * where what fills them — its colour's alpha by `globalAlpha` — is over
 * `threshold`, and draws nothing. Curves are cut into chords; anything it
 * is asked that is not a path, a fill or a transform does nothing.
 */
export function recordFills(
  draw: (ctx: unknown) => void,
  threshold: number,
): number[][] {
  const out: number[][] = [];
  let m = [1, 0, 0, 1, 0, 0];
  let alpha = 1;
  let fillStyle: unknown = '#000';
  const stack: { m: number[]; alpha: number; fillStyle: unknown }[] = [];
  let paths: number[][] = [];
  let current: number[] | null = null;
  let cx = 0;
  let cy = 0;
  const put = (x: number, y: number): void => {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    if (!current) paths.push((current = []));
    current.push(px, py);
    cx = x;
    cy = y;
  };
  const curve = (pt: (t: number) => [number, number], n = 24): void => {
    for (let k = 1; k <= n; k += 1) {
      const [x, y] = pt(k / n);
      put(x, y);
    }
  };
  const mul = (a: number[]): void => {
    m = [
      m[0] * a[0] + m[2] * a[1],
      m[1] * a[0] + m[3] * a[1],
      m[0] * a[2] + m[2] * a[3],
      m[1] * a[2] + m[3] * a[3],
      m[0] * a[4] + m[2] * a[5] + m[4],
      m[1] * a[4] + m[3] * a[5] + m[5],
    ];
  };
  const opaque = (): boolean => {
    const a = typeof fillStyle === 'string' ? colorAlpha(fillStyle) : 1;
    return a * alpha * 255 > threshold * 255;
  };
  const ellipse = (
    x: number,
    y: number,
    rx: number,
    ry: number,
    rot: number,
    a0: number,
    a1: number,
    ccw = false,
  ): void => {
    let sweep = a1 - a0;
    if (!ccw && sweep < 0)
      sweep += 2 * Math.PI * Math.ceil(-sweep / (2 * Math.PI));
    if (ccw && sweep > 0)
      sweep -= 2 * Math.PI * Math.ceil(sweep / (2 * Math.PI));
    if (Math.abs(sweep) > 2 * Math.PI) sweep = Math.sign(sweep) * 2 * Math.PI;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const at = (t: number): [number, number] => {
      const a = a0 + sweep * t;
      const ex = rx * Math.cos(a);
      const ey = ry * Math.sin(a);
      return [x + ex * cos - ey * sin, y + ex * sin + ey * cos];
    };
    const [sx, sy] = at(0);
    put(sx, sy);
    curve(at, Math.max(8, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * 64)));
  };
  const target: Record<string, (...args: any[]) => unknown> = {
    save: () => stack.push({ m, alpha, fillStyle }),
    restore: () => {
      const top = stack.pop();
      if (top) ({ m, alpha, fillStyle } = top);
    },
    beginPath: () => {
      paths = [];
      current = null;
    },
    moveTo: (x: number, y: number) => {
      current = null;
      put(x, y);
    },
    lineTo: (x: number, y: number) => put(x, y),
    closePath: () => {
      current = null;
    },
    bezierCurveTo: (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      x: number,
      y: number,
    ) => {
      const x0 = cx;
      const y0 = cy;
      curve((t) => {
        const u = 1 - t;
        return [
          u * u * u * x0 +
            3 * u * u * t * x1 +
            3 * u * t * t * x2 +
            t * t * t * x,
          u * u * u * y0 +
            3 * u * u * t * y1 +
            3 * u * t * t * y2 +
            t * t * t * y,
        ];
      });
    },
    quadraticCurveTo: (x1: number, y1: number, x: number, y: number) => {
      const x0 = cx;
      const y0 = cy;
      curve((t) => {
        const u = 1 - t;
        return [
          u * u * x0 + 2 * u * t * x1 + t * t * x,
          u * u * y0 + 2 * u * t * y1 + t * t * y,
        ];
      });
    },
    arc: (
      x: number,
      y: number,
      r: number,
      a0: number,
      a1: number,
      ccw?: boolean,
    ) => ellipse(x, y, r, r, 0, a0, a1, ccw),
    ellipse,
    rect: (x: number, y: number, w: number, h: number) => {
      current = null;
      put(x, y);
      put(x + w, y);
      put(x + w, y + h);
      put(x, y + h);
      current = null;
    },
    roundRect: (x: number, y: number, w: number, h: number) => {
      current = null;
      put(x, y);
      put(x + w, y);
      put(x + w, y + h);
      put(x, y + h);
      current = null;
    },
    fill: (path?: unknown) => {
      if (!opaque()) return;
      if (path && typeof path === 'object') {
        // a path object: ntk's `Path2D`, which has no public way to read it
        // back, so its command list is read as it is laid out, and one that
        // has none fills nothing here
        const cmds = (path as { _cmds?: unknown })._cmds;
        if (!Array.isArray(cmds)) return;
        const saved = paths;
        paths = [];
        current = null;
        for (const c of cmds as PathCommand[]) {
          if (c.type === 'M') target.moveTo!(c.x, c.y);
          else if (c.type === 'L') put(c.x!, c.y!);
          else if (c.type === 'C')
            target.bezierCurveTo!(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
          else if (c.type === 'Q')
            target.quadraticCurveTo!(c.x1, c.y1, c.x, c.y);
          else if (c.type === 'Z') current = null;
        }
        for (const p of paths) if (p.length >= 6) out.push(p);
        paths = saved;
        current = null;
        return;
      }
      for (const p of paths) if (p.length >= 6) out.push(p.slice());
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      if (!opaque()) return;
      const saved = paths;
      paths = [];
      current = null;
      put(x, y);
      put(x + w, y);
      put(x + w, y + h);
      put(x, y + h);
      out.push(paths[0]);
      paths = saved;
      current = null;
    },
    translate: (x: number, y: number) => mul([1, 0, 0, 1, x, y]),
    scale: (x: number, y: number) => mul([x, 0, 0, y, 0, 0]),
    rotate: (a: number) =>
      mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]),
    transform: (
      a: number,
      b: number,
      c: number,
      d: number,
      e: number,
      f: number,
    ) => mul([a, b, c, d, e, f]),
    setTransform: (
      a:
        | number
        | { a: number; b: number; c: number; d: number; e: number; f: number },
      b?: number,
      c?: number,
      d?: number,
      e?: number,
      f?: number,
    ) => {
      m =
        typeof a === 'object'
          ? [a.a, a.b, a.c, a.d, a.e, a.f]
          : [a, b!, c!, d!, e!, f!];
    },
    resetTransform: () => {
      m = [1, 0, 0, 1, 0, 0];
    },
    getTransform: () => ({
      a: m[0],
      b: m[1],
      c: m[2],
      d: m[3],
      e: m[4],
      f: m[5],
    }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => ({}),
    measureText: () => ({ width: 0 }),
  };
  const ctx = new Proxy(target, {
    get(t, key) {
      if (key === 'globalAlpha') return alpha;
      if (key === 'fillStyle') return fillStyle;
      if (key in t) return t[key as string];
      // a stroke, a clip, a draw of text or of an image is drawn as nothing,
      // and anything else it asks has no answer
      return typeof key === 'string' && DRAWN_AS_NOTHING.has(key)
        ? NOTHING
        : undefined;
    },
    set(t, key, value) {
      if (key === 'globalAlpha') alpha = Number(value);
      else if (key === 'fillStyle') fillStyle = value;
      else (t as Record<string, unknown>)[key as string] = value;
      return true;
    },
  });
  try {
    draw(ctx);
  } catch {
    // a drawing that throws part way has the area it filled so far
  }
  return out;
}

const NOTHING = (): void => {};
/** One of ntk's `Path2D` commands, as its `_cmds` holds them. */
interface PathCommand {
  type: string;
  x: number;
  y: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
const DRAWN_AS_NOTHING = new Set([
  'stroke',
  'strokeRect',
  'clearRect',
  'clip',
  'fillText',
  'strokeText',
  'drawImage',
  'putImageData',
  'setLineDash',
  'getLineDash',
  'addHitRegion',
]);

/** Polygons, their edges as numbers, and the extent of the area they and a
 *  margin around them cover over a band. */
class PolygonArea implements FloatShape {
  private readonly _edges: Float64Array;
  readonly top: number;
  readonly bottom: number;
  private readonly _empty: boolean;

  constructor(
    polys: number[][],
    private readonly _margin: number,
    private readonly _width: number,
    private readonly _height: number,
  ) {
    const edges: number[] = [];
    let top = Infinity;
    let bottom = -Infinity;
    let area = false;
    for (const poly of polys) {
      const n = poly.length >> 1;
      if (n === 0) continue;
      // whether it encloses any area: a vertex off the line of the others,
      // which a sum of signed areas misses for a bow tie whose two halves
      // turn opposite ways and are both filled
      let spread = 0;
      for (let i = 0; i < n; i += 1) {
        const x1 = poly[2 * i];
        const y1 = poly[2 * i + 1];
        const j = (i + 1) % n;
        const x2 = poly[2 * j];
        const y2 = poly[2 * j + 1];
        edges.push(x1, y1, x2, y2);
        spread += Math.abs(
          (x1 - poly[0]) * (y2 - poly[1]) - (x2 - poly[0]) * (y1 - poly[1]),
        );
        top = Math.min(top, y1);
        bottom = Math.max(bottom, y1);
      }
      if (spread > 1e-9) area = true;
    }
    this._edges = Float64Array.from(edges);
    // a shape of no area is nothing, unless a margin grows it into some
    this._empty = edges.length === 0 || (!area && !(_margin > 0));
    this.top = Math.max(0, top - _margin);
    this.bottom = Math.min(_height, bottom + _margin);
  }

  extent(top: number, bottom: number): readonly [number, number] | null {
    if (this._empty) return null;
    // clipped to the margin box (6.1)
    const t = Math.max(top, 0) + OPEN;
    const b = Math.min(bottom, this._height) - OPEN;
    if (b < t) return null;
    const r = this._margin;
    const lo = t - r;
    const hi = b + r;
    let min = Infinity;
    let max = -Infinity;
    const e = this._edges;
    const note = (x: number, y: number): void => {
      if (r > 0) {
        const d = y < t ? t - y : y > b ? y - b : 0;
        if (d > r) return;
        const dx = Math.sqrt(r * r - d * d);
        if (x - dx < min) min = x - dx;
        if (x + dx > max) max = x + dx;
      } else {
        if (x < min) min = x;
        if (x > max) max = x;
      }
    };
    for (let i = 0; i < e.length; i += 4) {
      const x1 = e[i];
      const y1 = e[i + 1];
      const x2 = e[i + 2];
      const y2 = e[i + 3];
      if ((y1 < lo && y2 < lo) || (y1 > hi && y2 > hi)) continue;
      if (y1 === y2) {
        note(x1, y1);
        note(x2, y2);
        continue;
      }
      // the edge's part in [lo, hi], by its parameter
      const at = (y: number) => (y - y1) / (y2 - y1);
      const s0 = Math.max(0, Math.min(at(lo), at(hi)));
      const s1 = Math.min(1, Math.max(at(lo), at(hi)));
      if (s1 < s0) continue;
      const point = (s: number) => note(x1 + (x2 - x1) * s, y1 + (y2 - y1) * s);
      point(s0);
      point(s1);
      if (r > 0) {
        // inside the band the extent is linear along the edge, so its ends
        // there; outside it a margin's reach bends, and is sampled
        const st = at(t);
        const sb = at(b);
        if (st > s0 && st < s1) point(st);
        if (sb > s0 && sb < s1) point(sb);
        const span = Math.abs((y2 - y1) * (s1 - s0));
        const n = Math.min(64, Math.max(2, Math.ceil(span / 0.25)));
        for (let k = 1; k < n; k += 1) point(s0 + ((s1 - s0) * k) / n);
      }
    }
    if (!(max >= min)) return null;
    min = Math.max(min, 0);
    max = Math.min(max, this._width);
    if (max < min) return null;
    return [min, max];
  }
}
