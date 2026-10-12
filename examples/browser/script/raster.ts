// A 2d canvas's paths, filled and stroked into the bitmap the page's realm
// holds: `Path2D`, the context's own path, gradients, patterns, clips and
// the compositing operators, rasterized in JavaScript.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` is handed it and calls it.
//
// Why here and not the host's context. The bitmap is the page's, so that
// `getImageData` reads back what was drawn at once, and a host context
// reads its pixels back a round trip later (`CanvasState` in `dom.ts`); a
// path drawn on the host's would be a picture the page could not read. So a
// path is flattened to polygons, and a polygon filled a pixel row at a time
// from its edges' crossings of five lines through the row, each span's ends
// covered by the part of a pixel they reach, which is the anti-aliasing. A
// stroke is the polygons its segments, joins and caps make, filled as one
// shape. Text is still drawn as nothing: it needs a font's outlines, which
// are the host's.

/** A path's commands, in the coordinates they were added in. */
export interface PathData {
  readonly cmds: number[];
  moveTo(x: number, y: number, m: Matrix): void;
  lineTo(x: number, y: number, m: Matrix): void;
  quadTo(cx: number, cy: number, x: number, y: number, m: Matrix): void;
  cubicTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
    m: Matrix,
  ): void;
  close(): void;
  rect(x: number, y: number, w: number, h: number, m: Matrix): void;
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: unknown,
    m: Matrix,
  ): void;
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    ccw: boolean,
    m: Matrix,
  ): void;
  arcTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    r: number,
    m: Matrix,
  ): void;
  addPath(other: PathData, m: Matrix): void;
}

/** An affine matrix as canvas has it: a, b, c, d, e, f. */
export type Matrix = number[];

/** What a fill or a stroke is painted with. */
export interface Paint {
  /** Premultiplied RGBA, 0 to 1, at a pixel's centre in the canvas. */
  at(x: number, y: number, out: Float64Array): void;
  /** One colour wherever it is: `at` need be asked once. */
  solid: boolean;
}

/** A canvas's bitmap: straight RGBA bytes. */
export interface Bitmap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** How a fill or a stroke is drawn: its paint, the alpha over it, the
 *  operator it is composited with and the clip it is cut to. */
export interface Draw {
  paint: Paint;
  alpha: number;
  op: string;
  clip: Float32Array | null;
}

export interface StrokeStyle {
  width: number;
  cap: string;
  join: string;
  miterLimit: number;
  dash: number[];
  dashOffset: number;
}

export interface RasterInstall {
  classes: Record<string, unknown>;
  newPath(): PathData;
  /** A `Path2D`'s commands, or null for what is no `Path2D`. */
  pathOf(path: unknown): PathData | null;
  /** Fill a path, its commands mapped by `m`, into a bitmap: answers the
   *  rectangle of pixels it changed, or null. */
  fill(
    target: Bitmap,
    path: PathData,
    m: Matrix,
    rule: string,
    draw: Draw,
  ): number[] | null;
  stroke(
    target: Bitmap,
    path: PathData,
    m: Matrix,
    style: StrokeStyle,
    draw: Draw,
  ): number[] | null;
  /** The coverage of a path over a whole bitmap, times the clip there was:
   *  what `clip()` leaves. */
  clipMask(
    width: number,
    height: number,
    path: PathData,
    m: Matrix,
    rule: string,
    was: Float32Array | null,
  ): Float32Array;
  contains(
    path: PathData,
    m: Matrix,
    x: number,
    y: number,
    rule: string,
  ): boolean;
  strokeContains(
    path: PathData,
    m: Matrix,
    style: StrokeStyle,
    x: number,
    y: number,
  ): boolean;
  /** A solid paint of straight RGBA bytes. */
  solid(rgba: number[]): Paint;
  /** A gradient's or a pattern's paint, under the matrix it is drawn
   *  through; null for what is neither. */
  paintOf(style: unknown, m: Matrix): Paint | null;
  makeLinear(x0: number, y0: number, x1: number, y1: number): unknown;
  makeRadial(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): unknown;
  makeConic(angle: number, x: number, y: number): unknown;
  makePattern(source: Bitmap, repetition: string): unknown;
}

export function installRaster(
  colourOf: (text: string) => number[] | null,
): RasterInstall {
  'use strict';
  type Any = any;

  const M = 0;
  const L = 1;
  const Q = 2;
  const C = 3;
  const Z = 4;
  const TAU = Math.PI * 2;
  const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

  const ap = (m: Matrix, x: number, y: number): [number, number] => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ];
  const invert = (m: Matrix): Matrix | null => {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det || !Number.isFinite(det)) return null;
    return [
      m[3] / det,
      -m[1] / det,
      -m[2] / det,
      m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det,
      (m[1] * m[4] - m[0] * m[5]) / det,
    ];
  };
  const finite = (...v: number[]) => v.every(Number.isFinite);

  // --- paths ------------------------------------------------------------------

  class Path implements PathData {
    cmds: number[] = [];
    /** The current point and the subpath's start, as added, and whether
     *  there is a current point. */
    cx = 0;
    cy = 0;
    sx = 0;
    sy = 0;
    has = false;
    moveTo(x: number, y: number, m: Matrix): void {
      if (!finite(x, y)) return;
      [x, y] = ap(m, x, y);
      this.cmds.push(M, x, y);
      this.cx = this.sx = x;
      this.cy = this.sy = y;
      this.has = true;
    }
    lineTo(x: number, y: number, m: Matrix): void {
      if (!finite(x, y)) return;
      if (!this.has) return this.moveTo(x, y, m);
      [x, y] = ap(m, x, y);
      this.cmds.push(L, x, y);
      this.cx = x;
      this.cy = y;
    }
    quadTo(cx: number, cy: number, x: number, y: number, m: Matrix): void {
      if (!finite(cx, cy, x, y)) return;
      if (!this.has) this.moveTo(cx, cy, m);
      const [a, b] = ap(m, cx, cy);
      [x, y] = ap(m, x, y);
      this.cmds.push(Q, a, b, x, y);
      this.cx = x;
      this.cy = y;
    }
    cubicTo(
      c1x: number,
      c1y: number,
      c2x: number,
      c2y: number,
      x: number,
      y: number,
      m: Matrix,
    ): void {
      if (!finite(c1x, c1y, c2x, c2y, x, y)) return;
      if (!this.has) this.moveTo(c1x, c1y, m);
      const [a, b] = ap(m, c1x, c1y);
      const [c, d] = ap(m, c2x, c2y);
      [x, y] = ap(m, x, y);
      this.cmds.push(C, a, b, c, d, x, y);
      this.cx = x;
      this.cy = y;
    }
    close(): void {
      if (!this.has) return;
      this.cmds.push(Z);
      this.cx = this.sx;
      this.cy = this.sy;
    }
    rect(x: number, y: number, w: number, h: number, m: Matrix): void {
      if (!finite(x, y, w, h)) return;
      this.moveTo(x, y, m);
      this.lineTo(x + w, y, m);
      this.lineTo(x + w, y + h, m);
      this.lineTo(x, y + h, m);
      this.close();
      this.moveTo(x, y, m);
    }
    roundRect(
      x: number,
      y: number,
      w: number,
      h: number,
      radii: unknown,
      m: Matrix,
    ): void {
      if (!finite(x, y, w, h)) return;
      const list = Array.isArray(radii)
        ? radii
        : radii === undefined
          ? [0]
          : [radii];
      if (list.length < 1 || list.length > 4) {
        throw new RangeError(
          `Failed to execute 'roundRect': ${list.length} radii provided. Between one and four radii are necessary.`,
        );
      }
      const corner = (r: Any): [number, number] => {
        const pair: [number, number] =
          r && typeof r === 'object'
            ? [Number(r.x ?? 0), Number(r.y ?? 0)]
            : [Number(r), Number(r)];
        if (pair[0] < 0 || pair[1] < 0) {
          throw new RangeError(
            "Failed to execute 'roundRect': The radius provided is negative.",
          );
        }
        return pair;
      };
      const r = list.map(corner);
      const [tl, tr, br, bl] =
        r.length === 1
          ? [r[0], r[0], r[0], r[0]]
          : r.length === 2
            ? [r[0], r[1], r[0], r[1]]
            : r.length === 3
              ? [r[0], r[1], r[2], r[1]]
              : r;
      // a box drawn from its far corner is the same box (HTML 4.12.5.1.8)
      if (w < 0) {
        x += w;
        w = -w;
      }
      if (h < 0) {
        y += h;
        h = -h;
      }
      // radii too large for the box are scaled down together
      const f = Math.min(
        1,
        w / (tl[0] + tr[0] || Infinity),
        w / (bl[0] + br[0] || Infinity),
        h / (tl[1] + bl[1] || Infinity),
        h / (tr[1] + br[1] || Infinity),
      );
      const k = 0.5522847498;
      const [a, b, c, d] = [tl, tr, br, bl].map(
        ([rx, ry]) => [rx * f, ry * f] as [number, number],
      );
      this.moveTo(x + a[0], y, m);
      this.lineTo(x + w - b[0], y, m);
      this.cubicTo(
        x + w - b[0] + b[0] * k,
        y,
        x + w,
        y + b[1] - b[1] * k,
        x + w,
        y + b[1],
        m,
      );
      this.lineTo(x + w, y + h - c[1], m);
      this.cubicTo(
        x + w,
        y + h - c[1] + c[1] * k,
        x + w - c[0] + c[0] * k,
        y + h,
        x + w - c[0],
        y + h,
        m,
      );
      this.lineTo(x + d[0], y + h, m);
      this.cubicTo(
        x + d[0] - d[0] * k,
        y + h,
        x,
        y + h - d[1] + d[1] * k,
        x,
        y + h - d[1],
        m,
      );
      this.lineTo(x, y + a[1], m);
      this.cubicTo(
        x,
        y + a[1] - a[1] * k,
        x + a[0] - a[0] * k,
        y,
        x + a[0],
        y,
        m,
      );
      this.close();
      this.moveTo(x, y, m);
    }
    ellipse(
      x: number,
      y: number,
      rx: number,
      ry: number,
      rotation: number,
      start: number,
      end: number,
      ccw: boolean,
      m: Matrix,
    ): void {
      if (!finite(x, y, rx, ry, rotation, start, end)) return;
      if (rx < 0 || ry < 0) {
        throw new DOMException(
          `The ${rx < 0 ? 'major' : 'minor'}-axis radius provided (${rx < 0 ? rx : ry}) is negative.`,
          'IndexSizeError',
        );
      }
      // the sweep, as canvas has it (HTML 4.12.5.1.8): a whole turn or
      // more is a whole turn, and less goes the way it is asked to
      let sweep: number;
      if (!ccw && end - start >= TAU) sweep = TAU;
      else if (ccw && start - end >= TAU) sweep = -TAU;
      else {
        sweep = (end - start) % TAU;
        if (!ccw && sweep < 0) sweep += TAU;
        if (ccw && sweep > 0) sweep -= TAU;
      }
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const point = (t: number): [number, number] => {
        const px = rx * Math.cos(t);
        const py = ry * Math.sin(t);
        return [x + px * cos - py * sin, y + px * sin + py * cos];
      };
      const deriv = (t: number): [number, number] => {
        const px = -rx * Math.sin(t);
        const py = ry * Math.cos(t);
        return [px * cos - py * sin, px * sin + py * cos];
      };
      const [x0, y0] = point(start);
      if (this.has) this.lineTo(x0, y0, m);
      else this.moveTo(x0, y0, m);
      const parts = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
      const step = sweep / parts;
      const k = (4 / 3) * Math.tan(step / 4);
      let t = start;
      for (let i = 0; i < parts; i += 1) {
        const t1 = t + step;
        const p0 = point(t);
        const p1 = point(t1);
        const d0 = deriv(t);
        const d1 = deriv(t1);
        this.cubicTo(
          p0[0] + d0[0] * k,
          p0[1] + d0[1] * k,
          p1[0] - d1[0] * k,
          p1[1] - d1[1] * k,
          p1[0],
          p1[1],
          m,
        );
        t = t1;
      }
    }
    arcTo(
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      r: number,
      m: Matrix,
    ): void {
      if (!finite(x1, y1, x2, y2, r)) return;
      if (r < 0) {
        throw new DOMException(
          `The radius provided (${r}) is negative.`,
          'IndexSizeError',
        );
      }
      if (!this.has) this.moveTo(x1, y1, m);
      // the current point, taken back into the space the arc is in
      const back = invert(m);
      if (!back) return;
      const [x0, y0] = ap(back, this.cx, this.cy);
      const ax = x0 - x1;
      const ay = y0 - y1;
      const bx = x2 - x1;
      const by = y2 - y1;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      const cross = ax * by - ay * bx;
      if (!la || !lb || !r || Math.abs(cross) < 1e-9) {
        this.lineTo(x1, y1, m);
        return;
      }
      const cosA = (ax * bx + ay * by) / (la * lb);
      const half = Math.acos(Math.max(-1, Math.min(1, cosA))) / 2;
      const dist = r / Math.tan(half);
      const t0x = x1 + (ax / la) * dist;
      const t0y = y1 + (ay / la) * dist;
      const t1x = x1 + (bx / lb) * dist;
      const t1y = y1 + (by / lb) * dist;
      // the centre, off the first tangent point toward the inside
      const nx = cross > 0 ? ay / la : -ay / la;
      const ny = cross > 0 ? -ax / la : ax / la;
      const cx = t0x - nx * r;
      const cy = t0y - ny * r;
      const a0 = Math.atan2(t0y - cy, t0x - cx);
      const a1 = Math.atan2(t1y - cy, t1x - cx);
      this.lineTo(t0x, t0y, m);
      this.ellipse(cx, cy, r, r, 0, a0, a1, cross > 0, m);
    }
    addPath(other: PathData, m: Matrix): void {
      const c = other.cmds;
      for (let i = 0; i < c.length;) {
        const op = c[i];
        if (op === M) {
          this.moveTo(c[i + 1], c[i + 2], m);
          i += 3;
        } else if (op === L) {
          this.lineTo(c[i + 1], c[i + 2], m);
          i += 3;
        } else if (op === Q) {
          this.quadTo(c[i + 1], c[i + 2], c[i + 3], c[i + 4], m);
          i += 5;
        } else if (op === C) {
          this.cubicTo(
            c[i + 1],
            c[i + 2],
            c[i + 3],
            c[i + 4],
            c[i + 5],
            c[i + 6],
            m,
          );
          i += 7;
        } else {
          this.close();
          i += 1;
        }
      }
    }
  }

  /** An SVG path's data (SVG 2, 9.3), into a path: what `new
   *  Path2D(text)` takes. Parsing stops at the first error, keeping what
   *  came before it. */
  const parseSvgPath = (text: string, path: Path): void => {
    const tokens =
      text.match(
        /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g,
      ) ?? [];
    let i = 0;
    let cmd = '';
    let x = 0;
    let y = 0;
    let sx = 0;
    let sy = 0;
    // the last control point, for a smooth curve's reflection
    let qx = 0;
    let qy = 0;
    let last = '';
    const num = (): number => {
      const t = tokens[i];
      if (t === undefined || /[a-zA-Z]/.test(t)) throw new Error('end');
      i += 1;
      return Number(t);
    };
    const flag = (): boolean => num() !== 0;
    try {
      while (i < tokens.length) {
        if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
        else if (!cmd) break;
        const rel = cmd === cmd.toLowerCase();
        const ox = rel ? x : 0;
        const oy = rel ? y : 0;
        switch (cmd.toUpperCase()) {
          case 'M': {
            x = ox + num();
            y = oy + num();
            path.moveTo(x, y, IDENTITY);
            sx = x;
            sy = y;
            // further pairs are lines
            cmd = rel ? 'l' : 'L';
            last = 'M';
            continue;
          }
          case 'L':
            x = ox + num();
            y = oy + num();
            path.lineTo(x, y, IDENTITY);
            break;
          case 'H':
            x = ox + num();
            path.lineTo(x, y, IDENTITY);
            break;
          case 'V':
            y = oy + num();
            path.lineTo(x, y, IDENTITY);
            break;
          case 'C': {
            const c1x = ox + num();
            const c1y = oy + num();
            const c2x = ox + num();
            const c2y = oy + num();
            x = ox + num();
            y = oy + num();
            path.cubicTo(c1x, c1y, c2x, c2y, x, y, IDENTITY);
            qx = c2x;
            qy = c2y;
            last = 'C';
            continue;
          }
          case 'S': {
            const c1x = last === 'C' ? 2 * x - qx : x;
            const c1y = last === 'C' ? 2 * y - qy : y;
            const c2x = ox + num();
            const c2y = oy + num();
            x = ox + num();
            y = oy + num();
            path.cubicTo(c1x, c1y, c2x, c2y, x, y, IDENTITY);
            qx = c2x;
            qy = c2y;
            last = 'C';
            continue;
          }
          case 'Q': {
            qx = ox + num();
            qy = oy + num();
            x = ox + num();
            y = oy + num();
            path.quadTo(qx, qy, x, y, IDENTITY);
            last = 'Q';
            continue;
          }
          case 'T': {
            qx = last === 'Q' ? 2 * x - qx : x;
            qy = last === 'Q' ? 2 * y - qy : y;
            x = ox + num();
            y = oy + num();
            path.quadTo(qx, qy, x, y, IDENTITY);
            last = 'Q';
            continue;
          }
          case 'A': {
            const rx = Math.abs(num());
            const ry = Math.abs(num());
            const rot = (num() * Math.PI) / 180;
            const large = flag();
            const sweep = flag();
            const x2 = ox + num();
            const y2 = oy + num();
            endpointArc(path, x, y, rx, ry, rot, large, sweep, x2, y2);
            x = x2;
            y = y2;
            break;
          }
          case 'Z':
            path.close();
            x = sx;
            y = sy;
            break;
          default:
            throw new Error('end');
        }
        last = cmd.toUpperCase();
      }
    } catch {
      // what came before the error stands
    }
  };

  /** An SVG arc from its end points (SVG 2, B.2.4), as an ellipse. */
  const endpointArc = (
    path: Path,
    x1: number,
    y1: number,
    rx: number,
    ry: number,
    rot: number,
    large: boolean,
    sweep: boolean,
    x2: number,
    y2: number,
  ): void => {
    if (x1 === x2 && y1 === y2) return;
    if (!rx || !ry) {
      path.lineTo(x2, y2, IDENTITY);
      return;
    }
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy;
    const y1p = -sin * dx + cos * dy;
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let k = Math.sqrt(Math.max(0, num / den));
    if (large === sweep) k = -k;
    const cxp = (k * rx * y1p) / ry;
    const cyp = (-k * ry * x1p) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) => {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    };
    const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = angle(
      (x1p - cxp) / rx,
      (y1p - cyp) / ry,
      (-x1p - cxp) / rx,
      (-y1p - cyp) / ry,
    );
    if (!sweep && dt > 0) dt -= TAU;
    if (sweep && dt < 0) dt += TAU;
    path.ellipse(cx, cy, rx, ry, rot, t1, t1 + dt, !sweep, IDENTITY);
  };

  const PATHS = new WeakMap<object, Path>();
  class Path2D {
    constructor(from?: Any) {
      const path = new Path();
      PATHS.set(this, path);
      if (from instanceof Path2D) path.addPath(PATHS.get(from)!, IDENTITY);
      else if (from !== undefined) parseSvgPath(String(from), path);
    }
    addPath(other: Any, transform?: Any): void {
      const from = other instanceof Path2D ? PATHS.get(other) : null;
      if (!from) {
        throw new TypeError(
          "Failed to execute 'addPath' on 'Path2D': parameter 1 is not of type 'Path2D'.",
        );
      }
      const t = transform ?? {};
      const m = [
        t.a ?? t.m11 ?? 1,
        t.b ?? t.m12 ?? 0,
        t.c ?? t.m21 ?? 0,
        t.d ?? t.m22 ?? 1,
        t.e ?? t.m41 ?? 0,
        t.f ?? t.m42 ?? 0,
      ].map(Number);
      if (!m.every(Number.isFinite)) return;
      own(this).addPath(from, m);
    }
    closePath(): void {
      own(this).close();
    }
    moveTo(x: Any, y: Any): void {
      own(this).moveTo(Number(x), Number(y), IDENTITY);
    }
    lineTo(x: Any, y: Any): void {
      own(this).lineTo(Number(x), Number(y), IDENTITY);
    }
    quadraticCurveTo(cx: Any, cy: Any, x: Any, y: Any): void {
      own(this).quadTo(Number(cx), Number(cy), Number(x), Number(y), IDENTITY);
    }
    bezierCurveTo(
      c1x: Any,
      c1y: Any,
      c2x: Any,
      c2y: Any,
      x: Any,
      y: Any,
    ): void {
      own(this).cubicTo(
        Number(c1x),
        Number(c1y),
        Number(c2x),
        Number(c2y),
        Number(x),
        Number(y),
        IDENTITY,
      );
    }
    arc(x: Any, y: Any, r: Any, a0: Any, a1: Any, ccw?: Any): void {
      own(this).ellipse(
        Number(x),
        Number(y),
        Number(r),
        Number(r),
        0,
        Number(a0),
        Number(a1),
        !!ccw,
        IDENTITY,
      );
    }
    arcTo(x1: Any, y1: Any, x2: Any, y2: Any, r: Any): void {
      own(this).arcTo(
        Number(x1),
        Number(y1),
        Number(x2),
        Number(y2),
        Number(r),
        IDENTITY,
      );
    }
    ellipse(
      x: Any,
      y: Any,
      rx: Any,
      ry: Any,
      rot: Any,
      a0: Any,
      a1: Any,
      ccw?: Any,
    ): void {
      own(this).ellipse(
        Number(x),
        Number(y),
        Number(rx),
        Number(ry),
        Number(rot),
        Number(a0),
        Number(a1),
        !!ccw,
        IDENTITY,
      );
    }
    rect(x: Any, y: Any, w: Any, h: Any): void {
      own(this).rect(Number(x), Number(y), Number(w), Number(h), IDENTITY);
    }
    roundRect(x: Any, y: Any, w: Any, h: Any, radii?: Any): void {
      own(this).roundRect(
        Number(x),
        Number(y),
        Number(w),
        Number(h),
        radii,
        IDENTITY,
      );
    }
  }
  const own = (p: object): Path => {
    const path = PATHS.get(p);
    if (!path) throw new TypeError('Illegal invocation');
    return path;
  };

  // --- flattening ---------------------------------------------------------

  /** A path as polylines, mapped by `m`, curves cut within a quarter of a
   *  pixel: each a flat list of points, and whether it was closed. */
  interface Polyline {
    pts: number[];
    closed: boolean;
  }
  const TOLERANCE = 0.25;
  const flatten = (path: PathData, m: Matrix): Polyline[] => {
    const out: Polyline[] = [];
    let cur: Polyline | null = null;
    const c = path.cmds;
    let x = 0;
    let y = 0;
    const push = (px: number, py: number) => {
      cur!.pts.push(px, py);
      x = px;
      y = py;
    };
    for (let i = 0; i < c.length;) {
      const op = c[i];
      if (op === M) {
        const [px, py] = ap(m, c[i + 1], c[i + 2]);
        cur = { pts: [], closed: false };
        out.push(cur);
        push(px, py);
        i += 3;
      } else if (op === L) {
        const [px, py] = ap(m, c[i + 1], c[i + 2]);
        push(px, py);
        i += 3;
      } else if (op === Q) {
        const [ax, ay] = ap(m, c[i + 1], c[i + 2]);
        const [bx, by] = ap(m, c[i + 3], c[i + 4]);
        const dd = Math.hypot(x - 2 * ax + bx, y - 2 * ay + by);
        const n = Math.min(
          1000,
          Math.max(1, Math.ceil(Math.sqrt((0.25 * dd) / TOLERANCE))),
        );
        const x0 = x;
        const y0 = y;
        for (let k = 1; k <= n; k += 1) {
          const t = k / n;
          const u = 1 - t;
          push(
            u * u * x0 + 2 * u * t * ax + t * t * bx,
            u * u * y0 + 2 * u * t * ay + t * t * by,
          );
        }
        i += 5;
      } else if (op === C) {
        const [ax, ay] = ap(m, c[i + 1], c[i + 2]);
        const [bx, by] = ap(m, c[i + 3], c[i + 4]);
        const [ex, ey] = ap(m, c[i + 5], c[i + 6]);
        const dd = Math.max(
          Math.hypot(x - 2 * ax + bx, y - 2 * ay + by),
          Math.hypot(ax - 2 * bx + ex, ay - 2 * by + ey),
        );
        const n = Math.min(
          1000,
          Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / TOLERANCE))),
        );
        const x0 = x;
        const y0 = y;
        for (let k = 1; k <= n; k += 1) {
          const t = k / n;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const d = 3 * u * t * t;
          const e = t * t * t;
          push(
            a * x0 + b * ax + d * bx + e * ex,
            a * y0 + b * ay + d * by + e * ey,
          );
        }
        i += 7;
      } else {
        if (cur) {
          cur.closed = true;
          // a command after a close starts at the subpath's start
          const [px, py] = [cur.pts[0], cur.pts[1]];
          cur = { pts: [], closed: false };
          out.push(cur);
          push(px, py);
        }
        i += 1;
      }
    }
    return out.filter((p) => p.pts.length >= 2);
  };

  // --- coverage ------------------------------------------------------------

  /** How many lines through each pixel row its edges' crossings are taken
   *  on: the vertical anti-aliasing's levels. */
  const SUB = 5;

  /** A shape's coverage of the pixels it reaches, 0 to 1, over the
   *  rectangle `[x0, x1) × [y0, y1)` of a bitmap `width` by `height`. */
  interface Coverage {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    cov: Float32Array;
  }

  const cover = (
    polys: number[][],
    evenodd: boolean,
    width: number,
    height: number,
  ): Coverage | null => {
    // the edges, top to bottom, with which way each goes
    const ex0: number[] = [];
    const ey0: number[] = [];
    const ex1: number[] = [];
    const ey1: number[] = [];
    const dir: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of polys) {
      const n = p.length / 2;
      if (n < 2) continue;
      for (let k = 0; k < n; k += 1) {
        const ax = p[2 * k];
        const ay = p[2 * k + 1];
        const j = (k + 1) % n;
        const bx = p[2 * j];
        const by = p[2 * j + 1];
        if (!finite(ax, ay, bx, by)) continue;
        minX = Math.min(minX, ax);
        maxX = Math.max(maxX, ax);
        minY = Math.min(minY, ay);
        maxY = Math.max(maxY, ay);
        if (ay === by) continue;
        if (ay < by) {
          ex0.push(ax);
          ey0.push(ay);
          ex1.push(bx);
          ey1.push(by);
          dir.push(1);
        } else {
          ex0.push(bx);
          ey0.push(by);
          ex1.push(ax);
          ey1.push(ay);
          dir.push(-1);
        }
      }
    }
    if (!ex0.length) return null;
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(width, Math.ceil(maxX) + 1);
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(height, Math.ceil(maxY));
    if (x1 <= x0 || y1 <= y0) return null;
    const w = x1 - x0;
    const cov = new Float32Array(w * (y1 - y0));
    const order = ex0.map((_, i) => i).sort((a, b) => ey0[a] - ey0[b]);
    const active: number[] = [];
    let next = 0;
    const xs: number[] = [];
    const ds: number[] = [];
    const frac = new Float32Array(w + 1);
    const diff = new Float32Array(w + 2);
    const span = (a: number, b: number) => {
      // local, cut to the rectangle
      a = Math.max(a - x0, 0);
      b = Math.min(b - x0, w);
      if (b <= a) return;
      const fa = Math.floor(a);
      const fb = Math.floor(b);
      if (fa === fb) {
        frac[fa] += b - a;
        return;
      }
      frac[fa] += fa + 1 - a;
      diff[fa + 1] += 1;
      diff[fb] -= 1;
      if (fb < w) frac[fb] += b - fb;
    };
    for (let py = y0; py < y1; py += 1) {
      frac.fill(0);
      diff.fill(0);
      for (let s = 0; s < SUB; s += 1) {
        const sy = py + (s + 0.5) / SUB;
        while (next < order.length && ey0[order[next]] <= sy) {
          active.push(order[next]);
          next += 1;
        }
        xs.length = 0;
        ds.length = 0;
        for (let k = active.length - 1; k >= 0; k -= 1) {
          const e = active[k];
          if (ey1[e] <= sy) {
            active[k] = active[active.length - 1];
            active.pop();
            continue;
          }
          if (ey0[e] > sy) continue;
          const t = (sy - ey0[e]) / (ey1[e] - ey0[e]);
          const x = ex0[e] + (ex1[e] - ex0[e]) * t;
          // insertion, keeping the crossings in order
          let at = xs.length;
          xs.push(x);
          ds.push(dir[e]);
          while (at > 0 && xs[at - 1] > x) {
            xs[at] = xs[at - 1];
            ds[at] = ds[at - 1];
            at -= 1;
          }
          xs[at] = x;
          ds[at] = dir[e];
        }
        let wind = 0;
        let from = 0;
        for (let k = 0; k < xs.length; k += 1) {
          const was = evenodd ? wind & 1 : wind;
          wind += evenodd ? 1 : ds[k];
          const now = evenodd ? wind & 1 : wind;
          if (!was && now) from = xs[k];
          else if (was && !now) span(from, xs[k]);
        }
      }
      const row = (py - y0) * w;
      let run = 0;
      for (let x = 0; x < w; x += 1) {
        run += diff[x];
        const c = (run + frac[x]) / SUB;
        cov[row + x] = c > 1 ? 1 : c;
      }
    }
    return { x0, y0, x1, y1, cov };
  };

  /** The polygons a path's fill is: its polylines, each closed. */
  const fillPolys = (path: PathData, m: Matrix): number[][] =>
    flatten(path, m).map((p) => p.pts);

  // --- strokes ---------------------------------------------------------------

  /** The polygons a stroke is: a quad for each segment, a polygon for each
   *  join and each cap, all wound the same way, so that filled as one
   *  shape by the non-zero rule they are their union. */
  const strokePolys = (
    path: PathData,
    m: Matrix,
    style: StrokeStyle,
  ): number[][] => {
    // the pen's half width where the matrix puts it: a turn and a scale
    // keep it round, and a skew is taken as its area's scale
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const hw = (style.width * scale) / 2;
    if (!(hw > 0) || !Number.isFinite(hw)) return [];
    let lines = flatten(path, m);
    const dash = style.dash.map((d) => d * scale);
    if (dash.length && dash.some((d) => d > 0)) {
      lines = dashed(lines, dash, style.dashOffset * scale);
    }
    const out: number[][] = [];
    const add = (poly: number[]) => {
      // wound one way: positive area
      let area = 0;
      const n = poly.length / 2;
      for (let k = 0; k < n; k += 1) {
        const j = (k + 1) % n;
        area += poly[2 * k] * poly[2 * j + 1] - poly[2 * j] * poly[2 * k + 1];
      }
      if (area < 0) {
        const r: number[] = [];
        for (let k = n - 1; k >= 0; k -= 1)
          r.push(poly[2 * k], poly[2 * k + 1]);
        out.push(r);
      } else if (area > 0) out.push(poly);
    };
    const circle = (cx: number, cy: number) => {
      const n = Math.max(
        8,
        Math.min(
          256,
          Math.ceil(TAU / Math.acos(Math.max(-1, 1 - TOLERANCE / hw))),
        ),
      );
      const poly: number[] = [];
      for (let k = 0; k < n; k += 1) {
        const a = (k / n) * TAU;
        poly.push(cx + hw * Math.cos(a), cy + hw * Math.sin(a));
      }
      add(poly);
    };
    for (const line of lines) {
      // the points, each one once
      const p: number[] = [];
      for (let k = 0; k < line.pts.length; k += 2) {
        const x = line.pts[k];
        const y = line.pts[k + 1];
        const n = p.length;
        if (n && Math.abs(p[n - 2] - x) < 1e-9 && Math.abs(p[n - 1] - y) < 1e-9)
          continue;
        p.push(x, y);
      }
      let closed = line.closed;
      if (closed && p.length >= 4) {
        const n = p.length;
        if (
          Math.abs(p[n - 2] - p[0]) < 1e-9 &&
          Math.abs(p[n - 1] - p[1]) < 1e-9
        ) {
          p.length = n - 2;
        }
      }
      const n = p.length / 2;
      if (n === 1) {
        // a subpath of no length draws its caps alone, as a dot or a square
        if (style.cap === 'round') circle(p[0], p[1]);
        else if (style.cap === 'square') {
          add([
            p[0] - hw,
            p[1] - hw,
            p[0] + hw,
            p[1] - hw,
            p[0] + hw,
            p[1] + hw,
            p[0] - hw,
            p[1] + hw,
          ]);
        }
        continue;
      }
      if (n === 2) closed = false;
      const segs = closed ? n : n - 1;
      const dirs: number[] = [];
      for (let k = 0; k < segs; k += 1) {
        const j = (k + 1) % n;
        const dx = p[2 * j] - p[2 * k];
        const dy = p[2 * j + 1] - p[2 * k + 1];
        const len = Math.hypot(dx, dy);
        dirs.push(dx / len, dy / len);
        const nx = (-dy / len) * hw;
        const ny = (dx / len) * hw;
        add([
          p[2 * k] + nx,
          p[2 * k + 1] + ny,
          p[2 * j] + nx,
          p[2 * j + 1] + ny,
          p[2 * j] - nx,
          p[2 * j + 1] - ny,
          p[2 * k] - nx,
          p[2 * k + 1] - ny,
        ]);
      }
      // the joins: at every point between two segments
      const joinAt = (v: number, a: number, b: number) => {
        const vx = p[2 * v];
        const vy = p[2 * v + 1];
        const d1x = dirs[2 * a];
        const d1y = dirs[2 * a + 1];
        const d2x = dirs[2 * b];
        const d2y = dirs[2 * b + 1];
        const cross = d1x * d2y - d1y * d2x;
        const dot = d1x * d2x + d1y * d2y;
        if (Math.abs(cross) < 1e-9 && dot > 0) return;
        if (style.join === 'round') {
          circle(vx, vy);
          return;
        }
        // the outer side's offsets
        const s = cross > 0 ? -1 : 1;
        const o1x = -d1y * s;
        const o1y = d1x * s;
        const o2x = -d2y * s;
        const o2y = d2x * s;
        const a1x = vx + o1x * hw;
        const a1y = vy + o1y * hw;
        const a2x = vx + o2x * hw;
        const a2y = vy + o2y * hw;
        const cosT = o1x * o2x + o1y * o2y;
        if (style.join === 'miter' && 1 + cosT > 1e-9) {
          const ratio = Math.sqrt(2 / (1 + cosT));
          if (ratio <= style.miterLimit) {
            const f = hw / (1 + cosT);
            add([
              vx,
              vy,
              a1x,
              a1y,
              vx + (o1x + o2x) * f,
              vy + (o1y + o2y) * f,
              a2x,
              a2y,
            ]);
            return;
          }
        }
        add([vx, vy, a1x, a1y, a2x, a2y]);
      };
      for (let k = 1; k < (closed ? n : n - 1); k += 1) joinAt(k, k - 1, k);
      if (closed) joinAt(0, segs - 1, 0);
      else {
        // the caps, at either end
        const cap = (x: number, y: number, dx: number, dy: number) => {
          if (style.cap === 'round') circle(x, y);
          else if (style.cap === 'square') {
            const nx = -dy * hw;
            const ny = dx * hw;
            add([
              x + nx,
              y + ny,
              x + nx + dx * hw,
              y + ny + dy * hw,
              x - nx + dx * hw,
              y - ny + dy * hw,
              x - nx,
              y - ny,
            ]);
          }
        };
        cap(p[0], p[1], -dirs[0], -dirs[1]);
        cap(p[2 * n - 2], p[2 * n - 1], dirs[2 * segs - 2], dirs[2 * segs - 1]);
      }
    }
    return out;
  };

  /** Polylines cut into a dash pattern's dashes, open each. */
  const dashed = (
    lines: Polyline[],
    dash: number[],
    offset: number,
  ): Polyline[] => {
    const pattern = dash.length % 2 ? dash.concat(dash) : dash;
    const total = pattern.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return lines;
    const out: Polyline[] = [];
    for (const line of lines) {
      const pts = line.pts.slice();
      if (line.closed) pts.push(pts[0], pts[1]);
      // where in the pattern the line starts
      let phase = ((offset % total) + total) % total;
      let index = 0;
      while (phase >= pattern[index]) {
        phase -= pattern[index];
        index = (index + 1) % pattern.length;
      }
      let left = pattern[index] - phase;
      let on = index % 2 === 0;
      let cur: number[] | null = on ? [pts[0], pts[1]] : null;
      for (let k = 2; k < pts.length; k += 2) {
        let ax = pts[k - 2];
        let ay = pts[k - 1];
        const bx = pts[k];
        const by = pts[k + 1];
        let len = Math.hypot(bx - ax, by - ay);
        while (len > 0) {
          if (left >= len) {
            left -= len;
            if (cur) cur.push(bx, by);
            len = 0;
            break;
          }
          const t = left / len;
          const mx = ax + (bx - ax) * t;
          const my = ay + (by - ay) * t;
          if (cur) {
            cur.push(mx, my);
            out.push({ pts: cur, closed: false });
            cur = null;
          } else cur = [mx, my];
          len -= left;
          ax = mx;
          ay = my;
          index = (index + 1) % pattern.length;
          left = pattern[index];
          on = index % 2 === 0;
          if (!on && cur) {
            out.push({ pts: cur, closed: false });
            cur = null;
          }
          if (on && !cur) cur = [ax, ay];
        }
      }
      if (cur && cur.length >= 4) out.push({ pts: cur, closed: false });
    }
    return out;
  };

  // --- paint -------------------------------------------------------------------

  const solid = (rgba: number[]): Paint => {
    const a = rgba[3] / 255;
    const r = (rgba[0] / 255) * a;
    const g = (rgba[1] / 255) * a;
    const b = (rgba[2] / 255) * a;
    return {
      solid: true,
      at(_x: number, _y: number, out: Float64Array) {
        out[0] = r;
        out[1] = g;
        out[2] = b;
        out[3] = a;
      },
    };
  };

  const GRADIENTS = new WeakMap<object, Any>();
  class CanvasGradient {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
    addColorStop(offset: Any, color: Any): void {
      const g = GRADIENTS.get(this);
      if (!g) throw new TypeError('Illegal invocation');
      const o = Number(offset);
      if (!(o >= 0 && o <= 1)) {
        throw new DOMException(
          `The provided value (${String(offset)}) is outside the range (0.0, 1.0).`,
          'IndexSizeError',
        );
      }
      const rgba = colourOf(String(color));
      if (!rgba) {
        throw new DOMException(
          `The value provided ('${String(color)}') could not be parsed as a color.`,
          'SyntaxError',
        );
      }
      g.stops.push({ offset: o, rgba });
      g.stops.sort((a: Any, b: Any) => a.offset - b.offset);
      g.lut = null;
    }
  }
  const gradient = (data: Any): object => {
    const g = Object.create(CanvasGradient.prototype);
    GRADIENTS.set(g, { ...data, stops: [], lut: null });
    return g;
  };
  /** A gradient's colours at 1,024 steps, premultiplied, interpolated
   *  unpremultiplied between its stops, as canvas has it. */
  const lutOf = (g: Any): Float64Array | null => {
    if (!g.stops.length) return null;
    if (g.lut) return g.lut;
    const N = 1024;
    const lut = new Float64Array(N * 4);
    const stops = g.stops;
    for (let i = 0; i < N; i += 1) {
      const t = i / (N - 1);
      let k = 0;
      while (k < stops.length && stops[k].offset <= t) k += 1;
      const a = stops[Math.max(0, k - 1)];
      const b = stops[Math.min(stops.length - 1, k)];
      const span = b.offset - a.offset;
      const f = span > 0 ? (t - a.offset) / span : 0;
      const ch = (n: number) => a.rgba[n] + (b.rgba[n] - a.rgba[n]) * f;
      const alpha = ch(3) / 255;
      lut[4 * i] = (ch(0) / 255) * alpha;
      lut[4 * i + 1] = (ch(1) / 255) * alpha;
      lut[4 * i + 2] = (ch(2) / 255) * alpha;
      lut[4 * i + 3] = alpha;
    }
    g.lut = lut;
    return lut;
  };

  const PATTERNS = new WeakMap<object, Any>();
  class CanvasPattern {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
    setTransform(t?: Any): void {
      const p = PATTERNS.get(this);
      if (!p) throw new TypeError('Illegal invocation');
      const x = t ?? {};
      const m = [
        x.a ?? x.m11 ?? 1,
        x.b ?? x.m12 ?? 0,
        x.c ?? x.m21 ?? 0,
        x.d ?? x.m22 ?? 1,
        x.e ?? x.m41 ?? 0,
        x.f ?? x.m42 ?? 0,
      ].map(Number);
      if (m.every(Number.isFinite)) p.matrix = m;
    }
  }

  const NOTHING = new Float64Array(4);
  const paintOf = (style: unknown, m: Matrix): Paint | null => {
    const back = invert(m);
    const g = style && typeof style === 'object' ? GRADIENTS.get(style) : null;
    if (g) {
      const lut = lutOf(g);
      if (!lut || !back) return null;
      const pick = (t: number, out: Float64Array) => {
        if (!Number.isFinite(t)) {
          out.set(NOTHING);
          return;
        }
        const i = Math.round(Math.min(1, Math.max(0, t)) * 1023) * 4;
        out[0] = lut[i];
        out[1] = lut[i + 1];
        out[2] = lut[i + 2];
        out[3] = lut[i + 3];
      };
      if (g.kind === 'linear') {
        const dx = g.x1 - g.x0;
        const dy = g.y1 - g.y0;
        const len = dx * dx + dy * dy;
        return {
          solid: false,
          at(px, py, out) {
            if (!len) return out.set(NOTHING);
            const [ux, uy] = ap(back, px, py);
            pick(((ux - g.x0) * dx + (uy - g.y0) * dy) / len, out);
          },
        };
      }
      if (g.kind === 'conic') {
        return {
          solid: false,
          at(px, py, out) {
            const [ux, uy] = ap(back, px, py);
            let a = Math.atan2(uy - g.y, ux - g.x) - g.angle;
            a = ((a % TAU) + TAU) % TAU;
            pick(a / TAU, out);
          },
        };
      }
      // radial: the largest ω whose circle holds the point, its radius not
      // negative (HTML 4.12.5.1.10)
      const cdx = g.x1 - g.x0;
      const cdy = g.y1 - g.y0;
      const dr = g.r1 - g.r0;
      const a = cdx * cdx + cdy * cdy - dr * dr;
      return {
        solid: false,
        at(px, py, out) {
          const [ux, uy] = ap(back, px, py);
          const pdx = ux - g.x0;
          const pdy = uy - g.y0;
          const b = pdx * cdx + pdy * cdy + g.r0 * dr;
          const c = pdx * pdx + pdy * pdy - g.r0 * g.r0;
          let w: number;
          if (Math.abs(a) < 1e-12) {
            if (!b) return out.set(NOTHING);
            w = c / (2 * b);
            if (g.r0 + w * dr < 0) return out.set(NOTHING);
          } else {
            const disc = b * b - a * c;
            if (disc < 0) return out.set(NOTHING);
            const root = Math.sqrt(disc);
            const w1 = (b + root) / a;
            const w2 = (b - root) / a;
            const hi = Math.max(w1, w2);
            const lo = Math.min(w1, w2);
            if (g.r0 + hi * dr >= 0) w = hi;
            else if (g.r0 + lo * dr >= 0) w = lo;
            else return out.set(NOTHING);
          }
          pick(w, out);
        },
      };
    }
    const p = style && typeof style === 'object' ? PATTERNS.get(style) : null;
    if (p && back) {
      const pm = invert(p.matrix ?? IDENTITY) ?? IDENTITY;
      const src: Bitmap = p.source;
      const rx = p.repetition === 'repeat' || p.repetition === 'repeat-x';
      const ry = p.repetition === 'repeat' || p.repetition === 'repeat-y';
      return {
        solid: false,
        at(px, py, out) {
          const [ux, uy] = ap(back, px, py);
          const [sx, sy] = ap(pm, ux, uy);
          let ix = Math.floor(sx);
          let iy = Math.floor(sy);
          if (rx) ix = ((ix % src.width) + src.width) % src.width;
          if (ry) iy = ((iy % src.height) + src.height) % src.height;
          if (ix < 0 || iy < 0 || ix >= src.width || iy >= src.height) {
            return out.set(NOTHING);
          }
          const o = (iy * src.width + ix) * 4;
          const alpha = src.data[o + 3] / 255;
          out[0] = (src.data[o] / 255) * alpha;
          out[1] = (src.data[o + 1] / 255) * alpha;
          out[2] = (src.data[o + 2] / 255) * alpha;
          out[3] = alpha;
        },
      };
    }
    return null;
  };

  // --- compositing ---------------------------------------------------------

  /** The operators whose result outside the shape is not what was there:
   *  composited over the whole clip, not over the shape alone. */
  const UNBOUNDED = new Set([
    'copy',
    'source-in',
    'source-out',
    'destination-in',
    'destination-atop',
  ]);
  /** A separable blend mode's function of two straight colours, 0 to 1
   *  (Compositing 1, 5.3). */
  const BLENDS: Record<string, (s: number, d: number) => number> = {
    multiply: (s, d) => s * d,
    screen: (s, d) => s + d - s * d,
    overlay: (s, d) => (d <= 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d)),
    darken: (s, d) => Math.min(s, d),
    lighten: (s, d) => Math.max(s, d),
    'color-dodge': (s, d) =>
      d === 0 ? 0 : s >= 1 ? 1 : Math.min(1, d / (1 - s)),
    'color-burn': (s, d) =>
      d >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - d) / s),
    'hard-light': (s, d) => (s <= 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d)),
    'soft-light': (s, d) => {
      if (s <= 0.5) return d - (1 - 2 * s) * d * (1 - d);
      const g = d <= 0.25 ? ((16 * d - 12) * d + 4) * d : Math.sqrt(d);
      return d + (2 * s - 1) * (g - d);
    },
    difference: (s, d) => Math.abs(s - d),
    exclusion: (s, d) => s + d - 2 * s * d,
  };

  /** Composite a source colour, premultiplied, at the coverage `c` it has
   *  there, onto a straight RGBA pixel. */
  const blend = (
    data: Uint8ClampedArray,
    o: number,
    src: Float64Array,
    c: number,
    op: string,
    clip: number,
  ): void => {
    const sa = src[3] * c;
    const da = data[o + 3] / 255;
    const dr = (data[o] / 255) * da;
    const dg = (data[o + 1] / 255) * da;
    const db = (data[o + 2] / 255) * da;
    const s0 = src[0] * c;
    const s1 = src[1] * c;
    const s2 = src[2] * c;
    let fs: number;
    let fd: number;
    switch (op) {
      case 'copy':
        fs = 1;
        fd = 0;
        break;
      case 'destination-over':
        fs = 1 - da;
        fd = 1;
        break;
      case 'source-in':
        fs = da;
        fd = 0;
        break;
      case 'source-out':
        fs = 1 - da;
        fd = 0;
        break;
      case 'source-atop':
        fs = da;
        fd = 1 - sa;
        break;
      case 'destination-in':
        fs = 0;
        fd = sa;
        break;
      case 'destination-out':
        fs = 0;
        fd = 1 - sa;
        break;
      case 'destination-atop':
        fs = 1 - da;
        fd = sa;
        break;
      case 'xor':
        fs = 1 - da;
        fd = 1 - sa;
        break;
      case 'lighter':
        fs = 1;
        fd = 1;
        break;
      default:
        fs = 1;
        fd = 1 - sa;
    }
    let ra = sa * fs + da * fd;
    let rr = s0 * fs + dr * fd;
    let rg = s1 * fs + dg * fd;
    let rb = s2 * fs + db * fd;
    const mode = BLENDS[op];
    if (mode && sa > 0 && da > 0) {
      // the colours where both are, mixed by the mode
      const both = sa * da;
      const mix = (s: number, d: number) =>
        mode(Math.min(1, s / sa), Math.min(1, d / da));
      rr = s0 * (1 - da) + dr * (1 - sa) + both * mix(s0, dr);
      rg = s1 * (1 - da) + dg * (1 - sa) + both * mix(s1, dg);
      rb = s2 * (1 - da) + db * (1 - sa) + both * mix(s2, db);
      ra = sa + da - both;
    }
    if (clip < 1) {
      ra = da + (ra - da) * clip;
      rr = dr + (rr - dr) * clip;
      rg = dg + (rg - dg) * clip;
      rb = db + (rb - db) * clip;
    }
    if (ra > 1) ra = 1;
    if (ra <= 0) {
      data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
      return;
    }
    data[o] = Math.min(255, (rr / ra) * 255 + 0.5);
    data[o + 1] = Math.min(255, (rg / ra) * 255 + 0.5);
    data[o + 2] = Math.min(255, (rb / ra) * 255 + 0.5);
    data[o + 3] = ra * 255 + 0.5;
  };

  /** A shape's coverage painted into a bitmap: answers the rectangle it
   *  changed. */
  const paintCoverage = (
    target: Bitmap,
    shape: Coverage | null,
    draw: Draw,
  ): number[] | null => {
    const { width, height, data } = target;
    const unbounded = UNBOUNDED.has(draw.op);
    if (!shape && !unbounded) return null;
    const alpha = Math.min(1, Math.max(0, draw.alpha));
    const x0 = unbounded ? 0 : shape!.x0;
    const y0 = unbounded ? 0 : shape!.y0;
    const x1 = unbounded ? width : shape!.x1;
    const y1 = unbounded ? height : shape!.y1;
    const src = new Float64Array(4);
    if (draw.paint.solid) draw.paint.at(0, 0, src);
    const clip = draw.clip;
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const k = clip ? clip[py * width + px] : 1;
        if (k <= 0) continue;
        let c = 0;
        if (
          shape &&
          px >= shape.x0 &&
          px < shape.x1 &&
          py >= shape.y0 &&
          py < shape.y1
        ) {
          c =
            shape.cov[(py - shape.y0) * (shape.x1 - shape.x0) + px - shape.x0];
        }
        if (c <= 0 && !unbounded) continue;
        if (!draw.paint.solid) draw.paint.at(px + 0.5, py + 0.5, src);
        blend(data, (py * width + px) * 4, src, c * alpha, draw.op, k);
      }
    }
    return [x0, y0, x1, y1];
  };

  /** Whether a point is inside polygons by a rule. */
  const inside = (
    polys: number[][],
    x: number,
    y: number,
    evenodd: boolean,
  ): boolean => {
    let wind = 0;
    for (const p of polys) {
      const n = p.length / 2;
      for (let k = 0; k < n; k += 1) {
        const j = (k + 1) % n;
        const ax = p[2 * k];
        const ay = p[2 * k + 1];
        const bx = p[2 * j];
        const by = p[2 * j + 1];
        if (ay <= y === by <= y) continue;
        const cx = ax + ((y - ay) / (by - ay)) * (bx - ax);
        if (cx > x) wind += by > ay ? 1 : -1;
      }
    }
    return evenodd ? (wind & 1) === 1 : wind !== 0;
  };

  return {
    classes: { Path2D, CanvasGradient, CanvasPattern },
    newPath: () => new Path(),
    pathOf: (p) => (p && typeof p === 'object' ? (PATHS.get(p) ?? null) : null),
    fill(target, path, m, rule, draw) {
      const shape = cover(
        fillPolys(path, m),
        rule === 'evenodd',
        target.width,
        target.height,
      );
      return paintCoverage(target, shape, draw);
    },
    stroke(target, path, m, style, draw) {
      const shape = cover(
        strokePolys(path, m, style),
        false,
        target.width,
        target.height,
      );
      return paintCoverage(target, shape, draw);
    },
    clipMask(width, height, path, m, rule, was) {
      const mask = new Float32Array(width * height);
      const shape = cover(
        fillPolys(path, m),
        rule === 'evenodd',
        width,
        height,
      );
      if (!shape) return mask;
      const w = shape.x1 - shape.x0;
      for (let y = shape.y0; y < shape.y1; y += 1) {
        for (let x = shape.x0; x < shape.x1; x += 1) {
          const c = shape.cov[(y - shape.y0) * w + x - shape.x0];
          mask[y * width + x] = was ? c * was[y * width + x] : c;
        }
      }
      return mask;
    },
    contains(path, m, x, y, rule) {
      return inside(fillPolys(path, m), x, y, rule === 'evenodd');
    },
    strokeContains(path, m, style, x, y) {
      return inside(strokePolys(path, m, style), x, y, false);
    },
    solid,
    paintOf,
    makeLinear: (x0, y0, x1, y1) =>
      gradient({ kind: 'linear', x0, y0, x1, y1 }),
    makeRadial: (x0, y0, r0, x1, y1, r1) => {
      if (r0 < 0 || r1 < 0) {
        throw new DOMException(
          `The ${r0 < 0 ? 'r0' : 'r1'} provided is less than 0.`,
          'IndexSizeError',
        );
      }
      return gradient({ kind: 'radial', x0, y0, r0, x1, y1, r1 });
    },
    makeConic: (angle, x, y) => gradient({ kind: 'conic', angle, x, y }),
    makePattern: (source, repetition) => {
      const p = Object.create(CanvasPattern.prototype);
      PATTERNS.set(p, { source, repetition, matrix: null });
      return p;
    },
  };
}
