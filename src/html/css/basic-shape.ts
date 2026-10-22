// Basic shapes (CSS Shapes 1, 3.1) as `border-shape` takes them: a circle,
// an ellipse, a polygon, a rectangle with its corners rounded or not, and an
// SVG path — each read as the cascade reads it, its lengths device pixels or
// percentages of the box it is measured in, and laid down for a box of a
// size as polygons (`shapePolygons`): curves are cut into chords no further
// than a tenth of a pixel from them, which is what every path a polygon
// is filled, clipped, stroked and hit-tested along here takes.

import {
  AUTO,
  parseLength,
  resolve,
  splitCommas,
  splitValue,
} from './values.js';
import type { Len, UnitContext } from './values.js';
import {
  parseShapeFunction,
  pathAsShape,
  shapePathData,
} from './shape-function.js';
import type { ShapeFunction } from './shape-function.js';

/** A circle's or an ellipse's radius: a length, or a side it reaches. */
type Radius = Len | 'closest-side' | 'farthest-side';

export type BasicShape =
  | { kind: 'circle'; r: Radius; at: readonly [Len, Len] }
  | { kind: 'ellipse'; rx: Radius; ry: Radius; at: readonly [Len, Len] }
  | { kind: 'polygon'; points: readonly Len[]; rule: FillRule }
  | {
      kind: 'inset' | 'rect' | 'xywh';
      lengths: readonly [Len, Len, Len, Len];
      /** The corners' radii, across and down, as `border-radius` has them;
       *  null for square ones. */
      radii: readonly [Len, Len, Len, Len] | null;
      radiiY: readonly [Len, Len, Len, Len] | null;
    }
  | {
      kind: 'path';
      /** Its subpaths as polygons, in device pixels from the box's corner,
       *  its curves cut into chords as it is read. */
      polys: readonly (readonly number[])[];
      rule: FillRule;
      /** The path data as written, for its computed value. */
      d: string;
      /** The same path as a `shape()`, which a `shape()` interpolates it
       *  with (`pathAsShape`); null where it reads as none. */
      asShape: ShapeFunction | null;
    }
  | {
      kind: 'shape';
      /** `shape()` (CSS Shapes 2, 4.2), whose commands are laid down as
       *  path data for the box (`shapePathData`). */
      shape: ShapeFunction;
    };

export type FillRule = 'nonzero' | 'evenodd';

/** How far a chord may stray from its curve, in device pixels: a tenth,
 *  where a quarter put two arcs of radii a twentieth of a pixel apart
 *  more pixels apart than WPT's shape tests allow. */
const TOLERANCE = 0.1;

/**
 * A basic shape, or null where `text` is none. `radiiOf` reads a `round`'s
 * radii as `border-radius` does.
 */
export function parseBasicShape(
  text: string,
  ctx: UnitContext,
  radiiOf: (
    value: string,
  ) => [[Len, Len, Len, Len], [Len, Len, Len, Len] | null] | null,
): BasicShape | null {
  const m = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(text.trim());
  if (!m) return null;
  const fn = m[1].toLowerCase();
  if (fn === 'shape') {
    const read = parseShapeFunction(text, ctx);
    return read && { kind: 'shape', shape: read.shape };
  }
  const inner = m[2].trim();
  const length = (part: string): Len | null => {
    const len = parseLength(part, ctx);
    return len === null || len === AUTO ? null : len;
  };
  switch (fn) {
    case 'circle':
    case 'ellipse': {
      const parts = splitValue(inner);
      const at = parts.findIndex((p) => p.toLowerCase() === 'at');
      const radii = at < 0 ? parts : parts.slice(0, at);
      const position = at < 0 ? ['center'] : parts.slice(at + 1);
      const want = fn === 'circle' ? 1 : 2;
      if (radii.length > want) return null;
      const read: Radius[] = [];
      for (const part of radii) {
        const word = part.toLowerCase();
        if (word === 'closest-side' || word === 'farthest-side') {
          read.push(word);
          continue;
        }
        const len = length(part);
        if (len === null || (typeof len === 'number' && len < 0)) return null;
        read.push(len);
      }
      const pos = positionOf(position, length);
      if (!pos) return null;
      if (fn === 'circle')
        return { kind: 'circle', r: read[0] ?? 'closest-side', at: pos };
      if (read.length === 1) return null;
      return {
        kind: 'ellipse',
        rx: read[0] ?? 'closest-side',
        ry: read[1] ?? 'closest-side',
        at: pos,
      };
    }
    case 'polygon': {
      const args = splitCommas(inner);
      let rule: FillRule = 'nonzero';
      const first = args[0]?.trim().toLowerCase();
      if (first === 'nonzero' || first === 'evenodd') {
        rule = first;
        args.shift();
      }
      if (!args.length) return null;
      const points: Len[] = [];
      for (const arg of args) {
        const pair = splitValue(arg.trim());
        if (pair.length !== 2) return null;
        for (const part of pair) {
          const len = length(part);
          if (len === null) return null;
          points.push(len);
        }
      }
      return { kind: 'polygon', points, rule };
    }
    case 'inset':
    case 'rect':
    case 'xywh': {
      const parts = splitValue(inner);
      const round = parts.findIndex((p) => p.toLowerCase() === 'round');
      const sides = round < 0 ? parts : parts.slice(0, round);
      let radii: [Len, Len, Len, Len] | null = null;
      let radiiY: [Len, Len, Len, Len] | null = null;
      if (round >= 0) {
        const read = radiiOf(parts.slice(round + 1).join(' '));
        if (!read) return null;
        [radii, radiiY] = read;
      }
      if (
        fn === 'inset' ? !sides.length || sides.length > 4 : sides.length !== 4
      ) {
        return null;
      }
      const lens: Len[] = [];
      for (const side of sides) {
        // `rect()` takes `auto` for an edge the box's own
        if (fn === 'rect' && side.toLowerCase() === 'auto') {
          lens.push(AUTO);
          continue;
        }
        const len = length(side);
        if (len === null) return null;
        lens.push(len);
      }
      const [a, b = a, c = a, d = b] = lens;
      return {
        kind: fn,
        lengths: fn === 'inset' ? [a, b, c, d] : (lens as [Len, Len, Len, Len]),
        radii,
        radiiY,
      };
    }
    case 'path': {
      const args = splitCommas(inner);
      let rule: FillRule = 'nonzero';
      if (args.length === 2) {
        const r = args[0].trim().toLowerCase();
        if (r !== 'nonzero' && r !== 'evenodd') return null;
        rule = r;
        args.shift();
      }
      if (args.length !== 1) return null;
      const quoted = /^(["'])([\s\S]*)\1$/.exec(args[0].trim());
      if (!quoted) return null;
      const polys = pathPolygons(quoted[2], ctx.scale);
      return polys
        ? {
            kind: 'path',
            polys,
            rule,
            d: quoted[2],
            asShape: pathAsShape(quoted[2], ctx.scale, rule),
          }
        : null;
    }
  }
  return null;
}

/** A position — one keyword or length across, and down — as the two
 *  lengths from the box's top left; null for one that is none. */
function positionOf(
  parts: readonly string[],
  length: (part: string) => Len | null,
): [Len, Len] | null {
  if (!parts.length || parts.length > 2) return null;
  const words = parts.map((p) => p.toLowerCase());
  const across = (word: string, part: string): Len | null =>
    word === 'left'
      ? 0
      : word === 'right'
        ? { pct: 100 }
        : word === 'center'
          ? { pct: 50 }
          : length(part);
  const down = (word: string, part: string): Len | null =>
    word === 'top'
      ? 0
      : word === 'bottom'
        ? { pct: 100 }
        : word === 'center'
          ? { pct: 50 }
          : length(part);
  if (parts.length === 1) {
    const w = words[0];
    if (w === 'top' || w === 'bottom') return [{ pct: 50 }, down(w, parts[0])!];
    const x = across(w, parts[0]);
    return x === null ? null : [x, { pct: 50 }];
  }
  // `top left` as well as `left top`
  let [first, second] = words;
  let [p0, p1] = parts;
  if (
    first === 'top' ||
    first === 'bottom' ||
    second === 'left' ||
    second === 'right'
  ) {
    [first, second] = [second, first];
    [p0, p1] = [p1, p0];
  }
  const x = across(first, p0);
  const y = down(second, p1);
  return x === null || y === null ? null : [x, y];
}

/**
 * A shape laid down in a box `w` by `h`, as its polygons — each a flat list
 * of `x, y` from the box's corner, in device pixels — and the rule they are
 * filled by. A percentage of a circle's radius is of the box's diagonal
 * over √2, and of an ellipse's of its own side; a rectangle's are as
 * `clip-path` measures them, its corners reduced together where they would
 * overlap.
 */
export function shapePolygons(
  shape: BasicShape,
  w: number,
  h: number,
): { polys: number[][]; rule: FillRule } {
  switch (shape.kind) {
    case 'circle':
    case 'ellipse': {
      const cx = resolve(shape.at[0], w);
      const cy = resolve(shape.at[1], h);
      const side = (r: Radius, base: number, near: number, far: number) =>
        r === 'closest-side'
          ? near
          : r === 'farthest-side'
            ? far
            : resolve(r, base);
      const nearX = Math.min(Math.abs(cx), Math.abs(w - cx));
      const farX = Math.max(Math.abs(cx), Math.abs(w - cx));
      const nearY = Math.min(Math.abs(cy), Math.abs(h - cy));
      const farY = Math.max(Math.abs(cy), Math.abs(h - cy));
      let rx: number;
      let ry: number;
      if (shape.kind === 'circle') {
        rx = ry = side(
          shape.r,
          Math.hypot(w, h) / Math.SQRT2,
          Math.min(nearX, nearY),
          Math.max(farX, farY),
        );
      } else {
        rx = side(shape.rx, w, nearX, farX);
        ry = side(shape.ry, h, nearY, farY);
      }
      return { polys: [ellipsePoints(cx, cy, rx, ry)], rule: 'nonzero' };
    }
    case 'polygon': {
      const points: number[] = [];
      for (let i = 0; i + 1 < shape.points.length; i += 2) {
        points.push(
          resolve(shape.points[i], w),
          resolve(shape.points[i + 1], h),
        );
      }
      return { polys: [points], rule: shape.rule };
    }
    case 'path':
      return { polys: shape.polys.map((p) => p.slice()), rule: shape.rule };
    case 'shape':
      // laid down in the box's own units, which are device pixels already
      return {
        polys: pathPolygons(shapePathData(shape.shape, w, h), 1) ?? [],
        rule: shape.shape.rule,
      };
    default: {
      const [a, b, c, d] = shape.lengths;
      let x0 = 0;
      let y0 = 0;
      let x1 = w;
      let y1 = h;
      if (shape.kind === 'inset') {
        x0 = resolve(d, w);
        y0 = resolve(a, h);
        x1 = w - resolve(b, w);
        y1 = h - resolve(c, h);
      } else if (shape.kind === 'rect') {
        y0 = a === AUTO ? 0 : resolve(a, h);
        x1 = b === AUTO ? w : resolve(b, w);
        y1 = c === AUTO ? h : resolve(c, h);
        x0 = d === AUTO ? 0 : resolve(d, w);
      } else {
        x0 = resolve(a, w);
        y0 = resolve(b, h);
        x1 = x0 + Math.max(0, resolve(c, w));
        y1 = y0 + Math.max(0, resolve(d, h));
      }
      x1 = Math.max(x0, x1);
      y1 = Math.max(y0, y1);
      return {
        polys: [
          roundedPoints(
            x0,
            y0,
            x1 - x0,
            y1 - y0,
            shape.radii,
            shape.radiiY ?? shape.radii,
            w,
            h,
          ),
        ],
        rule: 'nonzero',
      };
    }
  }
}

/** How many chords a curve that bends through `turn` radians at a radius
 *  of `r` takes, each within `TOLERANCE` of it. */
function chords(r: number, turn: number): number {
  if (!(r > TOLERANCE)) return 1;
  const step = 2 * Math.acos(1 - TOLERANCE / r);
  return Math.max(1, Math.min(256, Math.ceil(Math.abs(turn) / step)));
}

function ellipsePoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): number[] {
  const out: number[] = [];
  const n = Math.max(8, chords(Math.max(rx, ry), 2 * Math.PI));
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * 2 * Math.PI;
    out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  }
  return out;
}

/** A rectangle with its corners rounded by radii resolved against the box
 *  it is in, `boxW` by `boxH`, as `clip-path` resolves them, and reduced
 *  together where two on a side of the rectangle would overlap. */
function roundedPoints(
  x: number,
  y: number,
  w: number,
  h: number,
  across: readonly Len[] | null,
  down: readonly Len[] | null,
  boxW: number,
  boxH: number,
): number[] {
  if (!across || !down) return [x, y, x + w, y, x + w, y + h, x, y + h];
  const rx = across.map((r) => Math.max(0, resolve(r, boxW)));
  const ry = down.map((r) => Math.max(0, resolve(r, boxH)));
  let f = 1;
  const fit = (side: number, sum: number) => {
    if (sum > side) f = Math.min(f, side / sum);
  };
  fit(w, rx[0] + rx[1]);
  fit(h, ry[1] + ry[2]);
  fit(w, rx[2] + rx[3]);
  fit(h, ry[3] + ry[0]);
  for (let i = 0; i < 4; i += 1) {
    rx[i] *= f;
    ry[i] *= f;
  }
  const out: number[] = [];
  // each corner's quarter, from where it leaves one side to the next
  const corner = (cx: number, cy: number, i: number, from: number) => {
    const n = chords(Math.max(rx[i], ry[i]), Math.PI / 2);
    for (let k = 0; k <= n; k += 1) {
      const a = from + (k / n) * (Math.PI / 2);
      out.push(cx + rx[i] * Math.cos(a), cy + ry[i] * Math.sin(a));
    }
  };
  corner(x + rx[0], y + ry[0], 0, Math.PI);
  corner(x + w - rx[1], y + ry[1], 1, -Math.PI / 2);
  corner(x + w - rx[2], y + h - ry[2], 2, 0);
  corner(x + rx[3], y + h - ry[3], 3, Math.PI / 2);
  return out;
}

/**
 * SVG path data (SVG 2, 9.3) as polygons, its numbers CSS pixels scaled to
 * device ones: each subpath one, its curves and arcs cut into chords.
 * Null for data that is none.
 */
export function pathPolygons(d: string, scale: number): number[][] | null {
  const tokens = d.match(
    /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g,
  );
  if (!tokens || !/^[Mm]$/.test(tokens[0])) return null;
  const out: number[][] = [];
  let poly: number[] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  // the last control point, for a smooth curve's reflection
  let cx = 0;
  let cy = 0;
  let last = '';
  let i = 0;
  const num = (): number => {
    const t = tokens[i];
    if (t === undefined || /[A-Za-z]/.test(t)) throw new Error('number');
    i += 1;
    return Number(t);
  };
  const flags = (): number => num();
  const end = () => {
    if (poly.length >= 6) out.push(poly);
    poly = [];
  };
  const point = (px: number, py: number) => poly.push(px * scale, py * scale);
  const cubic = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    ex: number,
    ey: number,
  ) => {
    const reach =
      Math.hypot(x1 - x, y1 - y) +
      Math.hypot(x2 - x1, y2 - y1) +
      Math.hypot(ex - x2, ey - y2);
    const n = Math.max(4, Math.min(128, Math.ceil((reach * scale) / 4)));
    for (let k = 1; k <= n; k += 1) {
      const t = k / n;
      const u = 1 - t;
      point(
        u * u * u * x +
          3 * u * u * t * x1 +
          3 * u * t * t * x2 +
          t * t * t * ex,
        u * u * u * y +
          3 * u * u * t * y1 +
          3 * u * t * t * y2 +
          t * t * t * ey,
      );
    }
    [cx, cy, x, y] = [x2, y2, ex, ey];
  };
  try {
    let cmd = '';
    while (i < tokens.length) {
      const t = tokens[i];
      if (/[A-Za-z]/.test(t)) {
        cmd = t;
        i += 1;
      } else if (!cmd || cmd === 'Z' || cmd === 'z') {
        return null;
      } else if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
      const rel = cmd === cmd.toLowerCase();
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      switch (cmd.toUpperCase()) {
        case 'M': {
          end();
          x = ox + num();
          y = oy + num();
          sx = x;
          sy = y;
          point(x, y);
          break;
        }
        case 'L':
          x = ox + num();
          y = oy + num();
          point(x, y);
          break;
        case 'H':
          x = ox + num();
          point(x, y);
          break;
        case 'V':
          y = oy + num();
          point(x, y);
          break;
        case 'C': {
          const x1 = ox + num();
          const y1 = oy + num();
          const x2 = ox + num();
          const y2 = oy + num();
          cubic(x1, y1, x2, y2, ox + num(), oy + num());
          break;
        }
        case 'S': {
          const smooth = /[CcSs]/.test(last);
          const x1 = smooth ? 2 * x - cx : x;
          const y1 = smooth ? 2 * y - cy : y;
          const x2 = ox + num();
          const y2 = oy + num();
          cubic(x1, y1, x2, y2, ox + num(), oy + num());
          break;
        }
        case 'Q':
        case 'T': {
          const smooth = cmd.toUpperCase() === 'T';
          const qx = smooth
            ? /[QqTt]/.test(last)
              ? 2 * x - cx
              : x
            : ox + num();
          const qy = smooth
            ? /[QqTt]/.test(last)
              ? 2 * y - cy
              : y
            : oy + num();
          const ex = ox + num();
          const ey = oy + num();
          cubic(
            x + (2 / 3) * (qx - x),
            y + (2 / 3) * (qy - y),
            ex + (2 / 3) * (qx - ex),
            ey + (2 / 3) * (qy - ey),
            ex,
            ey,
          );
          cx = qx;
          cy = qy;
          break;
        }
        case 'A': {
          const rx = Math.abs(num());
          const ry = Math.abs(num());
          const rotation = (num() * Math.PI) / 180;
          const large = flags() !== 0;
          const sweep = flags() !== 0;
          const ex = ox + num();
          const ey = oy + num();
          arc(x, y, rx, ry, rotation, large, sweep, ex, ey, point, scale);
          x = ex;
          y = ey;
          break;
        }
        case 'Z':
          x = sx;
          y = sy;
          end();
          poly = [];
          break;
      }
      last = cmd;
    }
  } catch {
    return null;
  }
  end();
  return out.length ? out : null;
}

/** An elliptical arc (SVG 2, B.2.4) from where the path is to (ex, ey), as
 *  chords, after the point it starts at. */
function arc(
  x: number,
  y: number,
  rx: number,
  ry: number,
  phi: number,
  large: boolean,
  sweep: boolean,
  ex: number,
  ey: number,
  point: (x: number, y: number) => void,
  scale: number,
): void {
  if (!rx || !ry || (x === ex && y === ey)) {
    point(ex, ey);
    return;
  }
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x - ex) / 2;
  const dy = (y - ey) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  // radii too small to reach are grown until they do
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cx1 = (k * rx * y1) / ry;
  const cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (x + ex) / 2;
  const cy = sin * cx1 + cos * cy1 + (y + ey) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let turn = angle(
    (x1 - cx1) / rx,
    (y1 - cy1) / ry,
    (-x1 - cx1) / rx,
    (-y1 - cy1) / ry,
  );
  if (!sweep && turn > 0) turn -= 2 * Math.PI;
  if (sweep && turn < 0) turn += 2 * Math.PI;
  const n = chords(Math.max(rx, ry) * scale, turn);
  for (let i = 1; i <= n; i += 1) {
    const a = start + (turn * i) / n;
    const px = rx * Math.cos(a);
    const py = ry * Math.sin(a);
    point(cos * px - sin * py + cx, sin * px + cos * py + cy);
  }
}

/**
 * A band `width` wide along each of `polys`' edges, closed, and round at
 * its corners: what a stroke of the outline is, as polygons that all wind
 * one way, so that filled together under the non-zero rule they are one
 * shape — a context here fills, and strokes nothing.
 */
export function strokeBands(
  polys: readonly (readonly number[])[],
  width: number,
): number[][] {
  const half = width / 2;
  const out: number[][] = [];
  for (const p of polys) {
    const n = p.length / 2;
    for (let i = 0; i < n; i += 1) {
      const ax = p[2 * i];
      const ay = p[2 * i + 1];
      const bx = p[2 * ((i + 1) % n)];
      const by = p[2 * ((i + 1) % n) + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len > 0) {
        const nx = (-(by - ay) / len) * half;
        const ny = ((bx - ax) / len) * half;
        out.push(
          clockwise([
            ax + nx,
            ay + ny,
            bx + nx,
            by + ny,
            bx - nx,
            by - ny,
            ax - nx,
            ay - ny,
          ]),
        );
      }
      // a round join at each corner
      out.push(clockwise(ellipsePoints(ax, ay, half, half)));
    }
  }
  return out;
}

/** A polygon wound the way a polygon with a positive area in a y-down
 *  space is: reversed where it is not. */
function clockwise(points: number[]): number[] {
  let area = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    area += points[i] * points[j + 1] - points[j] * points[i + 1];
  }
  if (area >= 0) return points;
  const out: number[] = [];
  for (let i = points.length - 2; i >= 0; i -= 2)
    out.push(points[i], points[i + 1]);
  return out;
}
