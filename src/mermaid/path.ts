// SVG geometry, reduced to what a 2D context draws: absolute moves, lines,
// cubics and closes, already put through the transform of every group
// around them.
//
// Pure, and with no display: `scene.ts` hands it the shapes ondine writes
// (`path`, `rect`, `circle`, `polygon`, the occasional `ellipse` or
// `line`) and a matrix, and gets back segments in the diagram's own
// coordinates. Arcs become cubics here rather than `ctx.arc` calls, because
// an arc under a non-uniform transform is an ellipse no context draws, and
// because the icons architecture diagrams carry are written with them.

/** An affine transform, `[a, b, c, d, e, f]` as SVG and canvas write it. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` then `n`: a point goes through `n` first. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** How much a length grows through `m` — what a stroke width is scaled by.
 *  The geometric mean of the two axes, which is exact for the uniform
 *  scales ondine writes and a fair answer for any other. */
export function lengthScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

/** Whether `m` only moves things. */
export function isTranslation(m: Matrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
}

const TRANSFORM_FN =
  /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;

/** An SVG `transform` attribute. Anything it cannot read is left out, which
 *  draws the shape where it would be without that function rather than not
 *  at all. */
export function parseTransform(value: string | undefined): Matrix {
  if (!value) return IDENTITY;
  let m: Matrix = IDENTITY;
  let found: RegExpExecArray | null;
  TRANSFORM_FN.lastIndex = 0;
  while ((found = TRANSFORM_FN.exec(value))) {
    const args = numbers(found[2]);
    let n: Matrix | null = null;
    switch (found[1]) {
      case 'matrix':
        if (args.length === 6) n = args as unknown as Matrix;
        break;
      case 'translate':
        n = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case 'scale': {
        const sx = args[0] ?? 1;
        n = [sx, 0, 0, args[1] ?? sx, 0, 0];
        break;
      }
      case 'rotate': {
        const r = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        n = [cos, sin, -sin, cos, 0, 0];
        if (args.length >= 3) {
          const [cx, cy] = [args[1], args[2]];
          n = multiply(multiply([1, 0, 0, 1, cx, cy], n), [
            1,
            0,
            0,
            1,
            -cx,
            -cy,
          ]);
        }
        break;
      }
      case 'skewX':
        n = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        n = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    if (n && n.every(Number.isFinite)) m = multiply(m, n);
  }
  return m;
}

// --- segments ----------------------------------------------------------------

export type Seg =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | {
      c: 'C';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      x: number;
      y: number;
    }
  | { c: 'Z' };

/** Every segment through `m` — a cubic's control points go through an
 *  affine map exactly. */
export function transformSegs(segs: Seg[], m: Matrix): Seg[] {
  if (m === IDENTITY) return segs;
  return segs.map((s): Seg => {
    switch (s.c) {
      case 'M':
      case 'L': {
        const [x, y] = apply(m, s.x, s.y);
        return { c: s.c, x, y };
      }
      case 'C': {
        const [x1, y1] = apply(m, s.x1, s.y1);
        const [x2, y2] = apply(m, s.x2, s.y2);
        const [x, y] = apply(m, s.x, s.y);
        return { c: 'C', x1, y1, x2, y2, x, y };
      }
      default:
        return s;
    }
  });
}

/** The box the segments' points fall in — control points included, which
 *  only ever makes it larger, as a hit area may be. */
export function segBounds(
  segs: Seg[],
): { x: number; y: number; width: number; height: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const see = (x: number, y: number): void => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const s of segs) {
    if (s.c === 'Z') continue;
    if (s.c === 'C') {
      see(s.x1, s.y1);
      see(s.x2, s.y2);
    }
    see(s.x, s.y);
  }
  if (x0 > x1) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

function numbers(text: string): number[] {
  return (text.match(NUMBER) ?? []).map(Number);
}

/** A quarter circle's control-point distance, as a fraction of its radius. */
const KAPPA = 0.5522847498307936;

export function ellipseSegs(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): Seg[] {
  if (!(rx > 0) || !(ry > 0)) return [];
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { c: 'M', x: cx + rx, y: cy },
    {
      c: 'C',
      x1: cx + rx,
      y1: cy + ky,
      x2: cx + kx,
      y2: cy + ry,
      x: cx,
      y: cy + ry,
    },
    {
      c: 'C',
      x1: cx - kx,
      y1: cy + ry,
      x2: cx - rx,
      y2: cy + ky,
      x: cx - rx,
      y: cy,
    },
    {
      c: 'C',
      x1: cx - rx,
      y1: cy - ky,
      x2: cx - kx,
      y2: cy - ry,
      x: cx,
      y: cy - ry,
    },
    {
      c: 'C',
      x1: cx + kx,
      y1: cy - ry,
      x2: cx + rx,
      y2: cy - ky,
      x: cx + rx,
      y: cy,
    },
    { c: 'Z' },
  ];
}

/** A `rect`, with SVG's rules for its corner radii: one given is both, and
 *  neither may pass half the side it rounds. */
export function rectSegs(
  x: number,
  y: number,
  w: number,
  h: number,
  rxIn?: number,
  ryIn?: number,
): Seg[] {
  if (!(w > 0) || !(h > 0)) return [];
  let rx = rxIn !== undefined && rxIn > 0 ? rxIn : undefined;
  let ry = ryIn !== undefined && ryIn > 0 ? ryIn : undefined;
  rx ??= ry ?? 0;
  ry ??= rx;
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  if (!rx || !ry) {
    return [
      { c: 'M', x, y },
      { c: 'L', x: x + w, y },
      { c: 'L', x: x + w, y: y + h },
      { c: 'L', x, y: y + h },
      { c: 'Z' },
    ];
  }
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const r = x + w;
  const b = y + h;
  return [
    { c: 'M', x: x + rx, y },
    { c: 'L', x: r - rx, y },
    { c: 'C', x1: r - rx + kx, y1: y, x2: r, y2: y + ry - ky, x: r, y: y + ry },
    { c: 'L', x: r, y: b - ry },
    { c: 'C', x1: r, y1: b - ry + ky, x2: r - rx + kx, y2: b, x: r - rx, y: b },
    { c: 'L', x: x + rx, y: b },
    { c: 'C', x1: x + rx - kx, y1: b, x2: x, y2: b - ry + ky, x, y: b - ry },
    { c: 'L', x, y: y + ry },
    { c: 'C', x1: x, y1: y + ry - ky, x2: x + rx - kx, y2: y, x: x + rx, y },
    { c: 'Z' },
  ];
}

/** `polygon` and `polyline` points. */
export function pointsSegs(points: string | undefined, close: boolean): Seg[] {
  const n = numbers(points ?? '');
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) {
    segs.push({ c: i ? 'L' : 'M', x: n[i], y: n[i + 1] });
  }
  if (close && segs.length) segs.push({ c: 'Z' });
  return segs;
}

// --- path data -----------------------------------------------------------------

const PATH_TOKEN =
  /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/**
 * SVG path data, all of it: relative forms, the shorthands, quadratics
 * raised to cubics, and arcs converted to cubics. A malformed tail ends
 * the path where it went wrong rather than throwing, which is what a
 * browser draws too.
 */
export function parsePath(d: string): Seg[] {
  const tokens = d.match(PATH_TOKEN) ?? [];
  const segs: Seg[] = [];
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  // the reflected control point the S and T shorthands use
  let qx = 0;
  let qy = 0;
  let prev = '';

  const isCmd = (t: string | undefined): boolean =>
    t !== undefined && /^[A-Za-z]$/.test(t);
  const num = (): number => {
    const t = tokens[i];
    if (t === undefined || isCmd(t)) throw new RangeError('path');
    i += 1;
    return Number(t);
  };
  // An arc's flags are single digits and may be written run together with
  // what follows (`a4 4 0 0116 0`), which the number pattern reads as one.
  const flag = (): number => {
    const t = tokens[i];
    if (t === undefined || isCmd(t)) throw new RangeError('path');
    if (t === '0' || t === '1') {
      i += 1;
      return Number(t);
    }
    if (t[0] === '0' || t[0] === '1') {
      tokens[i] = t.slice(1);
      return Number(t[0]);
    }
    throw new RangeError('path');
  };

  try {
    while (i < tokens.length) {
      if (isCmd(tokens[i])) {
        cmd = tokens[i];
        i += 1;
      } else if (cmd === '') {
        break;
      } else if (cmd === 'M') {
        cmd = 'L';
      } else if (cmd === 'm') {
        cmd = 'l';
      }
      const rel = cmd !== cmd.toUpperCase();
      const ox = rel ? cx : 0;
      const oy = rel ? cy : 0;
      const upper = cmd.toUpperCase();
      switch (upper) {
        case 'M': {
          cx = num() + ox;
          cy = num() + oy;
          sx = cx;
          sy = cy;
          segs.push({ c: 'M', x: cx, y: cy });
          break;
        }
        case 'L':
          cx = num() + ox;
          cy = num() + oy;
          segs.push({ c: 'L', x: cx, y: cy });
          break;
        case 'H':
          cx = num() + ox;
          segs.push({ c: 'L', x: cx, y: cy });
          break;
        case 'V':
          cy = num() + oy;
          segs.push({ c: 'L', x: cx, y: cy });
          break;
        case 'C':
        case 'S': {
          let x1: number;
          let y1: number;
          if (upper === 'C') {
            x1 = num() + ox;
            y1 = num() + oy;
          } else if (prev === 'C' || prev === 'S') {
            x1 = 2 * cx - qx;
            y1 = 2 * cy - qy;
          } else {
            x1 = cx;
            y1 = cy;
          }
          const x2 = num() + ox;
          const y2 = num() + oy;
          const x = num() + ox;
          const y = num() + oy;
          segs.push({ c: 'C', x1, y1, x2, y2, x, y });
          qx = x2;
          qy = y2;
          cx = x;
          cy = y;
          break;
        }
        case 'Q':
        case 'T': {
          let px: number;
          let py: number;
          if (upper === 'Q') {
            px = num() + ox;
            py = num() + oy;
          } else if (prev === 'Q' || prev === 'T') {
            px = 2 * cx - qx;
            py = 2 * cy - qy;
          } else {
            px = cx;
            py = cy;
          }
          const x = num() + ox;
          const y = num() + oy;
          segs.push({
            c: 'C',
            x1: cx + (2 / 3) * (px - cx),
            y1: cy + (2 / 3) * (py - cy),
            x2: x + (2 / 3) * (px - x),
            y2: y + (2 / 3) * (py - y),
            x,
            y,
          });
          qx = px;
          qy = py;
          cx = x;
          cy = y;
          break;
        }
        case 'A': {
          const rx = num();
          const ry = num();
          const rot = num();
          const large = flag();
          const sweep = flag();
          const x = num() + ox;
          const y = num() + oy;
          arcSegs(segs, cx, cy, rx, ry, rot, large === 1, sweep === 1, x, y);
          cx = x;
          cy = y;
          break;
        }
        case 'Z':
          segs.push({ c: 'Z' });
          cx = sx;
          cy = sy;
          break;
        default:
          return segs;
      }
      prev = upper;
    }
  } catch {
    // a malformed tail: keep what was read
  }
  return segs;
}

/**
 * An elliptical arc, endpoint form (SVG 1.1, F.6.5), as one cubic per
 * quarter turn or less.
 */
function arcSegs(
  out: Seg[],
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  rotation: number,
  large: boolean,
  sweep: boolean,
  x: number,
  y: number,
): void {
  if (x0 === x && y0 === y) return;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry) {
    out.push({ c: 'L', x, y });
    return;
  }
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cxp = (k * rx * y1p) / ry;
  const cyp = (-k * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
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
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;

  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const alpha = (4 / 3) * Math.tan(step / 4);
  const point = (t: number): [number, number] => {
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    return [cx + cos * ex - sin * ey, cy + sin * ex + cos * ey];
  };
  const tangent = (t: number): [number, number] => {
    const ex = -rx * Math.sin(t);
    const ey = ry * Math.cos(t);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  let t = t1;
  let [px, py] = [x0, y0];
  for (let i = 0; i < n; i++) {
    const tn = t + step;
    const [d1x, d1y] = tangent(t);
    const [d2x, d2y] = tangent(tn);
    const [ex, ey] = i === n - 1 ? [x, y] : point(tn);
    out.push({
      c: 'C',
      x1: px + alpha * d1x,
      y1: py + alpha * d1y,
      x2: ex - alpha * d2x,
      y2: ey - alpha * d2y,
      x: ex,
      y: ey,
    });
    [px, py] = [ex, ey];
    t = tn;
  }
}
