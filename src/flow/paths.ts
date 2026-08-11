// Edge routing. Every edge kind comes out as one polyline, curves included,
// and that is the whole design decision here:
//
//   - the pane hit-tests edges, places labels and points arrowheads, and one
//     representation means one implementation of each rather than four;
//   - ntk's `bezierCurveTo` flattens to segments anyway, so sampling costs
//     nothing a curve was not already paying;
//   - the sample count comes off the on-screen length, so a curve is as
//     smooth as the zoom can show and no smoother.
//
// Everything here works in whatever space its inputs are in. The pane builds
// paths in **screen** space, so the pixel-shaped constants it passes in
// (`scale`) are already multiplied by the zoom.
import { handleDirection } from './model.js';
import type { EdgeType, HandlePosition, XYPosition } from './types.js';

export interface PathEnd {
  x: number;
  y: number;
  position: HandlePosition;
}

export interface PathOptions {
  /** How far a step edge runs before it turns, and how far a self-loop
   * bulges. In the same units as the endpoints. */
  stepOffset: number;
  /** Corner radius for `'smoothstep'`. */
  radius: number;
  /** Multiplies the bezier's shoulder — the pane passes the zoom. */
  scale: number;
  /** Both ends are on the same node: route a loop rather than a line back
   * on itself. */
  loop?: boolean;
}

const BEZIER_CURVATURE = 0.25;

function dedupe(points: readonly XYPosition[]): XYPosition[] {
  const out: XYPosition[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(last.x - p.x) < 0.01 &&
      Math.abs(last.y - p.y) < 0.01
    ) {
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * How far a bezier's control point sits from its endpoint. Half the gap when
 * the two ends face each other, and a square root of it when they face away
 * — which is what stops a backwards edge from collapsing into a hairpin and
 * keeps a long one from bowing out proportionally forever.
 */
function shoulder(distance: number, scale: number): number {
  if (distance >= 0) return 0.5 * distance;
  // `scale` inside the root rather than outside it: the same curve drawn at
  // twice the zoom has to come out twice as big, and `sqrt(z·-d)` is what
  // `z · sqrt(-d/z)` — the graph-space shoulder, scaled — reduces to.
  return BEZIER_CURVATURE * 25 * Math.sqrt(scale * -distance);
}

function control(end: PathEnd, other: XYPosition, scale: number): XYPosition {
  switch (end.position) {
    case 'left':
      return { x: end.x - shoulder(end.x - other.x, scale), y: end.y };
    case 'right':
      return { x: end.x + shoulder(other.x - end.x, scale), y: end.y };
    case 'top':
      return { x: end.x, y: end.y - shoulder(end.y - other.y, scale) };
    default:
      return { x: end.x, y: end.y + shoulder(other.y - end.y, scale) };
  }
}

function sampleCubic(
  p0: XYPosition,
  c0: XYPosition,
  c1: XYPosition,
  p1: XYPosition,
): XYPosition[] {
  // The control polygon bounds the curve's length, so it is a cheap and
  // always-sufficient basis for how finely to sample it.
  const rough =
    Math.hypot(c0.x - p0.x, c0.y - p0.y) +
    Math.hypot(c1.x - c0.x, c1.y - c0.y) +
    Math.hypot(p1.x - c1.x, p1.y - c1.y);
  const steps = Math.max(8, Math.min(48, Math.round(rough / 6)));
  const points: XYPosition[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    points.push({
      x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
      y: a * p0.y + b * c0.y + c * c1.y + d * p1.y,
    });
  }
  return points;
}

function sampleQuadratic(
  p0: XYPosition,
  c: XYPosition,
  p1: XYPosition,
  steps: number,
): XYPosition[] {
  const points: XYPosition[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push({
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
    });
  }
  return points;
}

/** The orthogonal route between two handles: out along each handle's own
 * direction, then one or two turns to meet. */
function stepPoints(
  source: PathEnd,
  target: PathEnd,
  offset: number,
): XYPosition[] {
  const sd = handleDirection(source.position);
  const td = handleDirection(target.position);
  const s1 = { x: source.x + sd.x * offset, y: source.y + sd.y * offset };
  const t1 = { x: target.x + td.x * offset, y: target.y + td.y * offset };
  const points: XYPosition[] = [{ x: source.x, y: source.y }, s1];

  const sHorizontal = sd.x !== 0;
  const tHorizontal = td.x !== 0;
  if (sHorizontal && tHorizontal) {
    const mx = (s1.x + t1.x) / 2;
    points.push({ x: mx, y: s1.y }, { x: mx, y: t1.y });
  } else if (!sHorizontal && !tHorizontal) {
    const my = (s1.y + t1.y) / 2;
    points.push({ x: s1.x, y: my }, { x: t1.x, y: my });
  } else if (sHorizontal) {
    points.push({ x: t1.x, y: s1.y });
  } else {
    points.push({ x: s1.x, y: t1.y });
  }
  points.push(t1, { x: target.x, y: target.y });
  return dedupe(points);
}

/** Replace each interior corner with a quadratic fillet, so a step edge
 * reads as one stroke rather than as a staircase of butt joins. */
function roundCorners(
  points: readonly XYPosition[],
  radius: number,
): XYPosition[] {
  if (points.length < 3 || radius <= 0) return points as XYPosition[];
  const out: XYPosition[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    // never eat more than half of either arm, or two tight corners in a row
    // would cross each other
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      out.push(corner);
      continue;
    }
    const start = {
      x: corner.x + ((prev.x - corner.x) / inLen) * r,
      y: corner.y + ((prev.y - corner.y) / inLen) * r,
    };
    const end = {
      x: corner.x + ((next.x - corner.x) / outLen) * r,
      y: corner.y + ((next.y - corner.y) / outLen) * r,
    };
    out.push(start, ...sampleQuadratic(start, corner, end, 5));
  }
  out.push(points[points.length - 1]);
  return dedupe(out);
}

/** An edge whose two ends are on the same node: bulge out along both handle
 * directions, and sideways, so the loop encloses area instead of doubling
 * back over itself. */
function loopPoints(
  source: PathEnd,
  target: PathEnd,
  offset: number,
): XYPosition[] {
  const sd = handleDirection(source.position);
  const td = handleDirection(target.position);
  const reach = Math.max(28, offset * 2.6);
  const c0 = {
    x: source.x + sd.x * reach - sd.y * reach * 0.7,
    y: source.y + sd.y * reach + sd.x * reach * 0.7,
  };
  const c1 = {
    x: target.x + td.x * reach + td.y * reach * 0.7,
    y: target.y + td.y * reach - td.x * reach * 0.7,
  };
  return sampleCubic(source, c0, c1, target);
}

/** The polyline for one edge. */
export function edgePath(
  type: EdgeType | undefined,
  source: PathEnd,
  target: PathEnd,
  options: PathOptions,
): XYPosition[] {
  if (options.loop) return loopPoints(source, target, options.stepOffset);
  switch (type) {
    case 'straight':
      return dedupe([
        { x: source.x, y: source.y },
        { x: target.x, y: target.y },
      ]);
    case 'step':
      return stepPoints(source, target, options.stepOffset);
    case 'smoothstep':
      return roundCorners(
        stepPoints(source, target, options.stepOffset),
        options.radius,
      );
    default: {
      const c0 = control(source, target, options.scale);
      const c1 = control(target, source, options.scale);
      return sampleCubic(source, c0, c1, target);
    }
  }
}

/** Total length of a polyline. */
export function pathLength(points: readonly XYPosition[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    );
  }
  return total;
}

/** The point a fraction of the way along, by arc length — where a label
 * goes, and what a midpoint marker aims at. */
export function pointAtFraction(
  points: readonly XYPosition[],
  fraction: number,
): XYPosition {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  const target = pathLength(points) * fraction;
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    );
    if (walked + seg >= target) {
      const t = seg === 0 ? 0 : (target - walked) / seg;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    walked += seg;
  }
  return points[points.length - 1];
}

/** Where the last segment points, in radians — the arrowhead's heading. */
export function endAngle(points: readonly XYPosition[]): number {
  for (let i = points.length - 1; i > 0; i--) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    if (dx !== 0 || dy !== 0) return Math.atan2(dy, dx);
  }
  return 0;
}

/** Where the first segment points *backwards*, for a start marker. */
export function startAngle(points: readonly XYPosition[]): number {
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i].x - points[i + 1].x;
    const dy = points[i].y - points[i + 1].y;
    if (dx !== 0 || dy !== 0) return Math.atan2(dy, dx);
  }
  return 0;
}

/** Distance from a point to the nearest place on the polyline. What edge
 * hit-testing asks, since an edge has no area to be inside of. */
export function distanceToPath(
  points: readonly XYPosition[],
  p: XYPosition,
): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq),
          );
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/** The polyline's bounding box, for culling before anything is drawn. */
export function pathBounds(points: readonly XYPosition[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Pull the tip back off the node so a fat arrowhead sits beside the border
 * rather than half inside it. */
export function trimEnd(
  points: readonly XYPosition[],
  amount: number,
): XYPosition[] {
  if (amount <= 0 || points.length < 2) return points as XYPosition[];
  const out = points.slice();
  let left = amount;
  while (out.length > 1 && left > 0) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    const seg = Math.hypot(last.x - prev.x, last.y - prev.y);
    if (seg > left) {
      const t = (seg - left) / seg;
      out[out.length - 1] = {
        x: prev.x + (last.x - prev.x) * t,
        y: prev.y + (last.y - prev.y) * t,
      };
      return out;
    }
    left -= seg;
    out.pop();
  }
  return out;
}
