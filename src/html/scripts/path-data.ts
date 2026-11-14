// SVG Paths' `SVGPathData` (SVG 2's Paths module, "The SVGPathData
// interface"): a `<path>`'s `getPathData()`, `setPathData()` and
// `getPathSegmentAtLength()`, which read and write its `d` attribute as a
// list of `{ type, values }` segments.
//
// **This function is source text**, as `installSvgDom` is (`svg-dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` calls it with what it needs.
//
// What is read is the attribute, the base value, and never a CSS `d` or what
// an animation sets: a segment a page is handed is a plain object made for
// it, so it can keep it and change it without changing the path. Path data
// is read as far as it is path data (SVG 2, 9.5.4), and a list a page writes
// as far as its segments are segments.

/** What `installDom` hands this. */
export interface PathDataDeps {
  /** The element's `d` attribute as the tree keeps it, or null. */
  getD(el: unknown): string | null;
  /** Sets the `d` attribute, or takes it out for null, as `setAttribute`
   *  and `removeAttribute` would, records and all. */
  setD(el: unknown, value: string | null): void;
}

/** What `installDom` has of this: `SVGPathElement`'s members. */
export interface PathDataInstall {
  members: Record<string, PropertyDescriptor>;
}

export function installPathData(deps: PathDataDeps): PathDataInstall {
  'use strict';
  type Any = any;
  const isFinite = Number.isFinite;
  const fround = Math.fround;

  interface Seg {
    type: string;
    values: number[];
  }
  /** How many numbers each command takes. */
  const ARGS: Record<string, number> = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    C: 6,
    S: 4,
    Q: 4,
    T: 2,
    A: 7,
    Z: 0,
  };
  const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;

  /** Path data's segments (SVG 2, 9.3.9), a repeated command written out as
   *  the command it stands for, up to the first error. */
  const parse = (text: string | null): Seg[] => {
    const out: Seg[] = [];
    if (text === null) return out;
    let i = 0;
    const n = text.length;
    const space = (): void => {
      while (i < n && /[\s,]/.test(text[i])) i++;
    };
    const read = (flag: boolean): number | null => {
      space();
      if (flag) {
        if (text[i] === '0' || text[i] === '1') return +text[i++];
        return null;
      }
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m) return null;
      i += m[0].length;
      return +m[0];
    };
    space();
    let cmd = '';
    while (i < n) {
      const ch = text[i];
      if (/[A-Za-z]/.test(ch)) {
        if (!(ch.toUpperCase() in ARGS)) return out;
        if (!out.length && ch !== 'M' && ch !== 'm') return out;
        cmd = ch;
        i++;
      } else if (!cmd || cmd === 'Z' || cmd === 'z') return out;
      const up = cmd.toUpperCase();
      const values: number[] = [];
      for (let k = 0; k < ARGS[up]; k++) {
        const v = read(up === 'A' && (k === 3 || k === 4));
        if (v === null) return out;
        values.push(v);
      }
      out.push({ type: cmd, values });
      if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
      space();
    }
    return out;
  };

  // --- normalized: absolute M, L, C and Z ---------------------------------------

  /** Each segment as absolute `M`, `L`, `C` and `Z` (SVG Paths, "normalize"),
   *  by the segment it came from. */
  const normalize = (segs: Seg[]): Array<{ from: number; seg: Seg }> => {
    const out: Array<{ from: number; seg: Seg }> = [];
    let x = 0;
    let y = 0;
    let sx = 0;
    let sy = 0;
    // the last control point, for a smooth curve after a curve
    let cx = 0;
    let cy = 0;
    let last = '';
    segs.forEach((seg, from) => {
      const up = seg.type.toUpperCase();
      const rel = seg.type !== up && from > 0;
      const v = seg.values;
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      const push = (type: string, values: number[]): void => {
        out.push({ from, seg: { type, values } });
      };
      const cubic = (
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        ex: number,
        ey: number,
      ): void => {
        push('C', [x1, y1, x2, y2, ex, ey]);
      };
      switch (up) {
        case 'M':
          x = ox + v[0];
          y = oy + v[1];
          sx = x;
          sy = y;
          push('M', [x, y]);
          break;
        case 'L':
        case 'H':
        case 'V': {
          if (up !== 'V') x = up === 'H' ? ox + v[0] : ox + v[0];
          if (up === 'L') y = oy + v[1];
          if (up === 'V') y = oy + v[0];
          push('L', [x, y]);
          break;
        }
        case 'C':
          cubic(
            ox + v[0],
            oy + v[1],
            ox + v[2],
            oy + v[3],
            ox + v[4],
            oy + v[5],
          );
          cx = ox + v[2];
          cy = oy + v[3];
          x = ox + v[4];
          y = oy + v[5];
          break;
        case 'S': {
          const smooth = last === 'C' || last === 'S';
          const x1 = smooth ? 2 * x - cx : x;
          const y1 = smooth ? 2 * y - cy : y;
          cubic(x1, y1, ox + v[0], oy + v[1], ox + v[2], oy + v[3]);
          cx = ox + v[0];
          cy = oy + v[1];
          x = ox + v[2];
          y = oy + v[3];
          break;
        }
        case 'Q':
        case 'T': {
          let qx: number;
          let qy: number;
          let ex: number;
          let ey: number;
          if (up === 'Q') {
            qx = ox + v[0];
            qy = oy + v[1];
            ex = ox + v[2];
            ey = oy + v[3];
          } else {
            const smooth = last === 'Q' || last === 'T';
            qx = smooth ? 2 * x - cx : x;
            qy = smooth ? 2 * y - cy : y;
            ex = ox + v[0];
            ey = oy + v[1];
          }
          // a quadratic is the cubic of its control point two thirds of
          // the way from each end
          cubic(
            x + ((qx - x) * 2) / 3,
            y + ((qy - y) * 2) / 3,
            ex + ((qx - ex) * 2) / 3,
            ey + ((qy - ey) * 2) / 3,
            ex,
            ey,
          );
          cx = qx;
          cy = qy;
          x = ex;
          y = ey;
          break;
        }
        case 'A': {
          const ex = ox + v[5];
          const ey = oy + v[6];
          arcCubics(
            x,
            y,
            v[0],
            v[1],
            v[2],
            v[3] !== 0,
            v[4] !== 0,
            ex,
            ey,
            push,
          );
          x = ex;
          y = ey;
          break;
        }
        case 'Z':
          push('Z', []);
          x = sx;
          y = sy;
          break;
      }
      last = up;
    });
    return out;
  };
  /** An elliptical arc as cubics of a quarter turn or less (SVG 2, B.2.4), a
   *  line where a radius is nought, and nothing where its ends are one. */
  const arcCubics = (
    x1: number,
    y1: number,
    rxIn: number,
    ryIn: number,
    degrees: number,
    large: boolean,
    sweep: boolean,
    x2: number,
    y2: number,
    push: (type: string, values: number[]) => void,
  ): void => {
    if (x1 === x2 && y1 === y2) return;
    let rx = Math.abs(rxIn);
    let ry = Math.abs(ryIn);
    if (!rx || !ry) {
      push('L', [x2, y2]);
      return;
    }
    const phi = ((degrees % 360) * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const px = cos * dx + sin * dy;
    const py = -sin * dx + cos * dy;
    const lambda = (px * px) / (rx * rx) + (py * py) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const num = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px;
    const den = rx * rx * py * py + ry * ry * px * px;
    let co = den ? Math.sqrt(Math.max(0, num / den)) : 0;
    if (large === sweep) co = -co;
    const cxp = (co * rx * py) / ry;
    const cyp = (-co * ry * px) / rx;
    const ccx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const ccy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number): number =>
      Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = angle(1, 0, (px - cxp) / rx, (py - cyp) / ry);
    let dt = angle(
      (px - cxp) / rx,
      (py - cyp) / ry,
      (-px - cxp) / rx,
      (-py - cyp) / ry,
    );
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const pieces = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
    const step = dt / pieces;
    const k = (4 / 3) * Math.tan(step / 4);
    const at = (t: number): number[] => [
      ccx + rx * cos * Math.cos(t) - ry * sin * Math.sin(t),
      ccy + rx * sin * Math.cos(t) + ry * cos * Math.sin(t),
    ];
    const tangent = (t: number): number[] => [
      -rx * cos * Math.sin(t) - ry * sin * Math.cos(t),
      -rx * sin * Math.sin(t) + ry * cos * Math.cos(t),
    ];
    for (let i = 0; i < pieces; i++) {
      const a = t1 + i * step;
      const b = a + step;
      const p0 = at(a);
      const p3 = i === pieces - 1 ? [x2, y2] : at(b);
      const d0 = tangent(a);
      const d3 = tangent(b);
      push('C', [
        p0[0] + k * d0[0],
        p0[1] + k * d0[1],
        p3[0] - k * d3[0],
        p3[1] - k * d3[1],
        p3[0],
        p3[1],
      ]);
    }
  };

  // --- lengths --------------------------------------------------------------------

  /** Each segment's length along the path, by flattening what it is drawn
   *  as. */
  const lengths = (segs: Seg[]): number[] => {
    const out = segs.map(() => 0);
    let x = 0;
    let y = 0;
    let sx = 0;
    let sy = 0;
    for (const { from, seg } of normalize(segs)) {
      const v = seg.values;
      if (seg.type === 'M') {
        x = sx = v[0];
        y = sy = v[1];
      } else if (seg.type === 'L' || seg.type === 'Z') {
        const ex = seg.type === 'Z' ? sx : v[0];
        const ey = seg.type === 'Z' ? sy : v[1];
        out[from] += Math.hypot(ex - x, ey - y);
        x = ex;
        y = ey;
      } else {
        const steps = 64;
        let px = x;
        let py = y;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const u = 1 - t;
          const qx =
            u * u * u * x +
            3 * u * u * t * v[0] +
            3 * u * t * t * v[2] +
            t * t * t * v[4];
          const qy =
            u * u * u * y +
            3 * u * u * t * v[1] +
            3 * u * t * t * v[3] +
            t * t * t * v[5];
          out[from] += Math.hypot(qx - px, qy - py);
          px = qx;
          py = qy;
        }
        x = v[4];
        y = v[5];
      }
    }
    return out;
  };

  // --- what a page hands in ---------------------------------------------------------

  const fmt = (n: number): string => {
    const r = Number(n.toPrecision(6));
    return Object.is(r, -0) ? '0' : String(r);
  };
  const text = (segs: Seg[]): string =>
    segs
      .map((s) =>
        s.type === 'Z' || s.type === 'z'
          ? 'Z'
          : [s.type, ...s.values.map(fmt)].join(' '),
      )
      .join(' ');
  /** A `sequence<SVGPathSegment>` (Web IDL 3.2.20): the segments, each a
   *  dictionary of a required `type` and `values`, up to the first that is
   *  no segment of path data. */
  const segmentsOf = (list: Any): Seg[] => {
    if (
      list === null ||
      (typeof list !== 'object' && typeof list !== 'function') ||
      typeof list[Symbol.iterator] !== 'function'
    ) {
      throw new TypeError(
        "Failed to execute 'setPathData' on 'SVGPathElement': The provided value cannot be converted to a sequence.",
      );
    }
    const all: Seg[] = [];
    for (const item of list) {
      if (item === null || item === undefined || typeof item !== 'object') {
        throw new TypeError(
          "Failed to execute 'setPathData' on 'SVGPathElement': The provided value is not of type 'SVGPathSegment'.",
        );
      }
      const type = item.type;
      if (type === undefined) {
        throw new TypeError(
          "Failed to execute 'setPathData' on 'SVGPathElement': required member type is undefined.",
        );
      }
      const values = item.values;
      if (values === undefined) {
        throw new TypeError(
          "Failed to execute 'setPathData' on 'SVGPathElement': required member values is undefined.",
        );
      }
      if (
        values === null ||
        typeof values !== 'object' ||
        typeof values[Symbol.iterator] !== 'function'
      ) {
        throw new TypeError(
          "Failed to execute 'setPathData' on 'SVGPathElement': The provided value cannot be converted to a sequence.",
        );
      }
      const nums: number[] = [];
      for (const n of values) nums.push(fround(Number(n)));
      const t = `${type}`;
      // an arc's flags are its third and fourth numbers made booleans
      // (SVG Paths, `setPathData()`): 2 and 5 are both 1
      if ((t === 'A' || t === 'a') && nums.length === 7) {
        for (const k of [3, 4]) {
          if (isFinite(nums[k])) nums[k] = nums[k] !== 0 ? 1 : 0;
        }
      }
      all.push({ type: t, values: nums });
    }
    const out: Seg[] = [];
    for (const seg of all) {
      const up = seg.type.length === 1 ? seg.type.toUpperCase() : '';
      if (!(up in ARGS)) break;
      if (!out.length && up !== 'M') break;
      if (seg.values.length !== ARGS[up] || !seg.values.every(isFinite)) break;
      out.push(seg);
    }
    return out;
  };

  const method = (fn: (...args: Any[]) => Any): PropertyDescriptor => ({
    value: fn,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const fresh = (seg: Seg): Seg => ({
    type: seg.type,
    values: seg.values.slice(),
  });
  return {
    members: {
      getPathData: method(function (this: Any, settings: Any = undefined) {
        const segs = parse(deps.getD(this));
        const normal =
          settings !== undefined && settings !== null && !!settings.normalize;
        return normal
          ? normalize(segs).map((n) => fresh(n.seg))
          : segs.map(fresh);
      }),
      setPathData: method(function (this: Any, list: Any) {
        if (arguments.length < 1) {
          throw new TypeError(
            "Failed to execute 'setPathData' on 'SVGPathElement': 1 argument required, but only 0 present.",
          );
        }
        const segs = segmentsOf(list);
        deps.setD(this, segs.length ? text(segs) : null);
      }),
      getPathSegmentAtLength: method(function (this: Any, distance: Any) {
        if (arguments.length < 1) {
          throw new TypeError(
            "Failed to execute 'getPathSegmentAtLength' on 'SVGPathElement': 1 argument required, but only 0 present.",
          );
        }
        const d = fround(Number(distance));
        if (!isFinite(d)) {
          throw new TypeError(
            "Failed to execute 'getPathSegmentAtLength' on 'SVGPathElement': The provided float value is non-finite.",
          );
        }
        const segs = parse(deps.getD(this));
        if (!segs.length) return null;
        const lens = lengths(segs);
        const total = lens.reduce((a, b) => a + b, 0);
        const at = Math.min(total, Math.max(0, d));
        // the first segment whose end is at or past the distance: an exact
        // boundary is the segment before it
        let sum = 0;
        for (let i = 0; i < segs.length; i++) {
          sum += lens[i];
          if (
            sum >= at - 1e-9 &&
            (lens[i] > 0 || at === 0 || i === segs.length - 1)
          ) {
            return fresh(segs[i]);
          }
        }
        return fresh(segs[segs.length - 1]);
      }),
    },
  };
}
