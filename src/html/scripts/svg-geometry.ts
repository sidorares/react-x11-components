// Where an inline drawing's elements are, for a page's script.
//
// No box stands for what a drawing holds, so `getBBox`, `getCTM` and
// `getBoundingClientRect` have no layout to read: mermaid measures every
// label it places with `getBBox`, and svg-pan-zoom moves a drawing with
// `getCTM`. All of it is worked out here from the attributes (SVG 2, 8.10,
// and 4.6.8 for the box), and the host answers it as an op. What is asked of
// `<Html>` is `SvgMeasure`: the size of a run of text, and where the outermost
// `<svg>` was laid out.
import { Element, Text } from 'domhandler';
import type { AnyNode } from 'domhandler';

import { multiply } from '../css/transform.js';
import type { Matrix } from '../css/transform.js';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SvgMeasure {
  text(
    el: Element,
    text: string,
  ): { width: number; ascent: number; descent: number };
  fontSize(el: Element): number;
  /** Where an outermost `<svg>` was laid out, in CSS pixels. */
  box(svg: Element): Box | null;
  /** Whether a style hides an element, and all it holds, from the drawing. */
  hidden(el: Element): boolean;
}

/** What a drawing holds and does not draw: it is drawn by what names it. */
const NEVER_DRAWN = /^(defs|symbol|clippath|mask|marker|pattern)$/;
/** Whether an element is one nothing renders (SVG 2, w3c/svgwg#1018), which
 *  has a box of nothing. */
function unrendered(el: Element, measure: SvgMeasure): boolean {
  for (let at: Element | null = el; at; at = at.parent as Element | null) {
    if (!(at instanceof Element) || isSvg(at)) return measure.hidden(el);
    if (NEVER_DRAWN.test(tag(at))) return true;
  }
  return measure.hidden(el);
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const tag = (el: Element): string => el.name.toLowerCase();
const attr = (el: Element, name: string): string | undefined =>
  el.attribs[name] ?? el.attribs[name.toLowerCase()];
const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const numbers = (text: string | undefined): number[] =>
  (text?.match(NUMBER) ?? []).map(Number);
/** A length attribute, in user units: `em` of the font, a percentage of
 *  `percent`, and every other unit a pixel but those of absolute size. */
const UNITS: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};
function length(
  raw: string | undefined,
  fontSize: number,
  percent: number,
): number {
  if (raw === undefined) return 0;
  const m =
    /^\s*([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)([a-z%]*)\s*$/i.exec(raw);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === '%') return (n / 100) * percent;
  if (unit === 'em') return n * fontSize;
  if (unit === 'ex') return n * fontSize * 0.5;
  if (unit === 'rem') return n * 16;
  return n * (UNITS[unit] ?? 1);
}

/** A `transform` attribute's matrix (SVG 2's transform list). */
export function ownTransform(el: Element): Matrix {
  const text = attr(el, 'transform');
  if (!text) return IDENTITY;
  let out = IDENTITY;
  for (const [, name, args] of text.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const n = numbers(args);
    const rad = ((n[0] ?? 0) * Math.PI) / 180;
    let m: Matrix = IDENTITY;
    if (name === 'matrix' && n.length >= 6) {
      m = [n[0], n[1], n[2], n[3], n[4], n[5]];
    } else if (name === 'translate') m = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0];
    else if (name === 'scale') m = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
    else if (name === 'rotate') {
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      m = [c, s, -s, c, 0, 0];
      if (n.length >= 3) {
        const about: Matrix = [1, 0, 0, 1, n[1], n[2]];
        m = multiply(multiply(about, m), [1, 0, 0, 1, -n[1], -n[2]]);
      }
    } else if (name === 'skewX') m = [1, 0, Math.tan(rad), 1, 0, 0];
    else if (name === 'skewY') m = [1, Math.tan(rad), 0, 1, 0, 0];
    out = multiply(out, m);
  }
  return out;
}

/** The elements of `el`, in order. */
const kids = (el: Element): Element[] =>
  el.children.filter((k): k is Element => k instanceof Element);
const isSvg = (el: Element): boolean => tag(el) === 'svg';
/** The nearest `<svg>` above an element, or null. */
function viewportOf(el: Element): Element | null {
  for (let at = el.parent; at; at = at.parent) {
    if (at instanceof Element && isSvg(at)) return at;
  }
  return null;
}
/** Where a viewBox goes in a viewport (SVG 2, 8.9), and how it is fitted. */
function viewBoxFit(svg: Element, width: number, height: number): Matrix {
  const box = numbers(attr(svg, 'viewBox'));
  if (box.length < 4 || !(box[2] > 0) || !(box[3] > 0)) return IDENTITY;
  const [minX, minY, vw, vh] = box;
  const par = (attr(svg, 'preserveAspectRatio') ?? 'xMidYMid meet').trim();
  const [align, slice] = par.split(/\s+/);
  let sx = width / vw;
  let sy = height / vh;
  if (align !== 'none') {
    sx = sy = slice === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
  }
  const place = (key: string, room: number): number => {
    if (align === 'none' || align.includes(`${key}Min`)) return 0;
    return align.includes(`${key}Max`) ? room : room / 2;
  };
  const tx = place('x', width - vw * sx) - minX * sx;
  const ty = place('Y', height - vh * sy) - minY * sy;
  return [sx, 0, 0, sy, tx, ty];
}
/** What an `<svg>` adds to the coordinates of what it holds: where it is
 *  placed, nested in another, and its viewBox. */
function viewportMatrix(svg: Element, measure: SvgMeasure): Matrix {
  const outer = viewportOf(svg);
  const em = measure.fontSize(svg);
  if (!outer) {
    const box = measure.box(svg);
    return viewBoxFit(svg, box?.width ?? 0, box?.height ?? 0);
  }
  const [pw, ph] = viewportSize(outer, measure);
  const width = length(attr(svg, 'width') ?? '100%', em, pw);
  const height = length(attr(svg, 'height') ?? '100%', em, ph);
  const x = length(attr(svg, 'x'), em, pw);
  const y = length(attr(svg, 'y'), em, ph);
  return multiply([1, 0, 0, 1, x, y], viewBoxFit(svg, width, height));
}
/** An `<svg>`'s size in the units of what it holds. */
function viewportSize(svg: Element, measure: SvgMeasure): [number, number] {
  const box = numbers(attr(svg, 'viewBox'));
  if (box.length >= 4) return [box[2], box[3]];
  const outer = viewportOf(svg);
  if (!outer) {
    const laid = measure.box(svg);
    return [laid?.width ?? 0, laid?.height ?? 0];
  }
  const [pw, ph] = viewportSize(outer, measure);
  const em = measure.fontSize(svg);
  return [
    length(attr(svg, 'width') ?? '100%', em, pw),
    length(attr(svg, 'height') ?? '100%', em, ph),
  ];
}

/** `getCTM`: from an element's user units to its viewport's. */
export function ctmOf(el: Element, measure: SvgMeasure): Matrix {
  if (isSvg(el)) return viewportMatrix(el, measure);
  let out = ownTransform(el);
  for (let at = el.parent; at; at = at.parent) {
    if (!(at instanceof Element)) break;
    if (isSvg(at)) return multiply(viewportMatrix(at, measure), out);
    out = multiply(ownTransform(at), out);
  }
  return out;
}
/** `getScreenCTM`: from an element's user units to the document's, which
 *  the facade makes the viewport's. Null where it is in no drawing laid out. */
export function screenCtmOf(el: Element, measure: SvgMeasure): Matrix | null {
  let out = ctmOf(el, measure);
  let svg = isSvg(el) ? el : viewportOf(el);
  while (svg) {
    const outer = viewportOf(svg);
    if (!outer) break;
    let up = IDENTITY;
    for (let at = svg.parent; at && at !== outer; at = at.parent) {
      if (at instanceof Element) up = multiply(ownTransform(at), up);
    }
    out = multiply(multiply(viewportMatrix(outer, measure), up), out);
    svg = outer;
  }
  const box = svg && measure.box(svg);
  return box ? multiply([1, 0, 0, 1, box.x, box.y], out) : null;
}

/** A path's lines, each a flat list of points: curves cut fine enough for
 *  a length and a box, and arcs each 15° (SVG 2, 9.3.8 and B.2.4). */
function pathLines(d: string): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  let i = 0;
  const space = (): void => {
    while (i < d.length && /[\s,]/.test(d[i])) i += 1;
  };
  const number = (): number | null => {
    space();
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m || m.index !== i) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): number | null => {
    space();
    const c = d[i];
    if (c !== '0' && c !== '1') return null;
    i += 1;
    return Number(c);
  };
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let controlX = 0;
  let controlY = 0;
  let previous = '';
  const to = (px: number, py: number): void => {
    line.push(px, py);
    x = px;
    y = py;
  };
  const cubic = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    ex: number,
    ey: number,
  ): void => {
    const [x0, y0] = [x, y];
    for (let s = 1; s <= 24; s += 1) {
      const t = s / 24;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const e = t * t * t;
      to(a * x0 + b * x1 + c * x2 + e * ex, a * y0 + b * y1 + c * y2 + e * ey);
    }
  };
  const quadratic = (qx: number, qy: number, ex: number, ey: number): void => {
    const [x0, y0] = [x, y];
    for (let s = 1; s <= 16; s += 1) {
      const t = s / 16;
      const u = 1 - t;
      to(
        u * u * x0 + 2 * u * t * qx + t * t * ex,
        u * u * y0 + 2 * u * t * qy + t * t * ey,
      );
    }
  };
  const arc = (
    rx: number,
    ry: number,
    angle: number,
    large: number,
    sweep: number,
    ex: number,
    ey: number,
  ): void => {
    let a = Math.abs(rx);
    let b = Math.abs(ry);
    if (!a || !b) {
      to(ex, ey);
      return;
    }
    const phi = (angle * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (x - ex) / 2;
    const dy = (y - ey) / 2;
    const px = cos * dx + sin * dy;
    const py = -sin * dx + cos * dy;
    const over = (px * px) / (a * a) + (py * py) / (b * b);
    if (over > 1) {
      a *= Math.sqrt(over);
      b *= Math.sqrt(over);
    }
    const top = a * a * b * b - a * a * py * py - b * b * px * px;
    const under = a * a * py * py + b * b * px * px;
    const root =
      (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, top / under));
    const cx0 = (root * a * py) / b;
    const cy0 = (-root * b * px) / a;
    const cx = cos * cx0 - sin * cy0 + (x + ex) / 2;
    const cy = sin * cx0 + cos * cy0 + (y + ey) / 2;
    const from = Math.atan2((py - cy0) / b, (px - cx0) / a);
    let turn = Math.atan2((-py - cy0) / b, (-px - cx0) / a) - from;
    if (sweep && turn < 0) turn += Math.PI * 2;
    if (!sweep && turn > 0) turn -= Math.PI * 2;
    const steps = Math.max(1, Math.ceil(Math.abs(turn) / (Math.PI / 12)));
    for (let s = 1; s <= steps; s += 1) {
      const t = from + (turn * s) / steps;
      const ux = a * Math.cos(t);
      const uy = b * Math.sin(t);
      to(cos * ux - sin * uy + cx, sin * ux + cos * uy + cy);
    }
    x = ex;
    y = ey;
  };
  let command = '';
  for (;;) {
    space();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i])) {
      command = d[i];
      i += 1;
    } else if (!command || command === 'z' || command === 'Z') break;
    const rel = command === command.toLowerCase();
    const X = rel ? x : 0;
    const Y = rel ? y : 0;
    switch (command.toLowerCase()) {
      case 'z':
        line.push(startX, startY);
        x = startX;
        y = startY;
        lines.push(line);
        line = [x, y];
        break;
      case 'm': {
        const a = number();
        const b = number();
        if (a === null || b === null) return lines;
        if (line.length > 2) lines.push(line);
        x = a + X;
        y = b + Y;
        startX = x;
        startY = y;
        line = [x, y];
        command = rel ? 'l' : 'L';
        break;
      }
      case 'l': {
        const a = number();
        const b = number();
        if (a === null || b === null) return lines;
        to(a + X, b + Y);
        break;
      }
      case 'h': {
        const a = number();
        if (a === null) return lines;
        to(a + X, y);
        break;
      }
      case 'v': {
        const a = number();
        if (a === null) return lines;
        to(x, a + Y);
        break;
      }
      case 'c':
      case 's': {
        const smooth = command.toLowerCase() === 's';
        const a = smooth ? null : number();
        const b = smooth ? null : number();
        const c = number();
        const e = number();
        const f = number();
        const g = number();
        if (c === null || e === null || f === null || g === null) return lines;
        const cont = /[cs]/i.test(previous);
        const x1 = smooth ? (cont ? 2 * x - controlX : x) : a! + X;
        const y1 = smooth ? (cont ? 2 * y - controlY : y) : b! + Y;
        controlX = c + X;
        controlY = e + Y;
        cubic(x1, y1, controlX, controlY, f + X, g + Y);
        break;
      }
      case 'q':
      case 't': {
        const smooth = command.toLowerCase() === 't';
        const a = smooth ? null : number();
        const b = smooth ? null : number();
        const c = number();
        const e = number();
        if (c === null || e === null) return lines;
        const cont = /[qt]/i.test(previous);
        controlX = smooth ? (cont ? 2 * x - controlX : x) : a! + X;
        controlY = smooth ? (cont ? 2 * y - controlY : y) : b! + Y;
        quadratic(controlX, controlY, c + X, e + Y);
        break;
      }
      case 'a': {
        const rx = number();
        const ry = number();
        const angle = number();
        const large = flag();
        const sweep = flag();
        const ex = number();
        const ey = number();
        if (
          rx === null ||
          ry === null ||
          angle === null ||
          large === null ||
          sweep === null ||
          ex === null ||
          ey === null
        ) {
          return lines;
        }
        arc(rx, ry, angle, large, sweep, ex + X, ey + Y);
        break;
      }
      default:
        return lines;
    }
    previous = command;
  }
  if (line.length > 2) lines.push(line);
  return lines;
}

/** A shape's outline, as lines of points in its user units. */
export function shapeLines(el: Element, measure: SvgMeasure): number[][] {
  const em = measure.fontSize(el);
  const svg = viewportOf(el);
  const [pw, ph] = svg ? viewportSize(svg, measure) : [0, 0];
  const across = (name: string): number => length(attr(el, name), em, pw);
  const down = (name: string): number => length(attr(el, name), em, ph);
  const ring = (cx: number, cy: number, rx: number, ry: number): number[] => {
    const out: number[] = [];
    for (let s = 0; s <= 96; s += 1) {
      const t = (s / 96) * Math.PI * 2;
      out.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
    }
    return out;
  };
  switch (tag(el)) {
    case 'path':
      return pathLines(attr(el, 'd') ?? '');
    case 'rect': {
      const [x, y, w, h] = [
        across('x'),
        down('y'),
        across('width'),
        down('height'),
      ];
      return [[x, y, x + w, y, x + w, y + h, x, y + h, x, y]];
    }
    case 'circle': {
      const r = length(attr(el, 'r'), em, Math.hypot(pw, ph) / Math.SQRT2);
      return [ring(across('cx'), down('cy'), r, r)];
    }
    case 'ellipse':
      return [ring(across('cx'), down('cy'), across('rx'), down('ry'))];
    case 'line':
      return [[across('x1'), down('y1'), across('x2'), down('y2')]];
    case 'polyline':
    case 'polygon': {
      const points = numbers(attr(el, 'points'));
      if (points.length < 2) return [];
      if (tag(el) === 'polygon') points.push(points[0], points[1]);
      return [points];
    }
    default:
      return [];
  }
}

/** The length of a shape's outline. */
export function totalLength(lines: number[][]): number {
  let total = 0;
  for (const line of lines) {
    for (let i = 2; i + 1 < line.length; i += 2) {
      total += Math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]);
    }
  }
  return total;
}
/** The point `distance` along a shape's outline, its ends where it is past
 *  them. */
export function pointAt(lines: number[][], distance: number): [number, number] {
  let left = Math.max(0, distance);
  let last: [number, number] = [0, 0];
  for (const line of lines) {
    if (line.length >= 2) last = [line[0], line[1]];
    for (let i = 2; i + 1 < line.length; i += 2) {
      const dx = line[i] - line[i - 2];
      const dy = line[i + 1] - line[i - 1];
      const step = Math.hypot(dx, dy);
      if (left <= step && step > 0) {
        const t = left / step;
        return [line[i - 2] + dx * t, line[i - 1] + dy * t];
      }
      left -= step;
      last = [line[i], line[i + 1]];
    }
  }
  return last;
}

/** A union of boxes, those of nothing left out. */
function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
const through = (m: Matrix, box: Box): Box => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

/** The pen a `<text>` writes with: where it is, moved by each `<tspan>`. */
interface Pen {
  x: number;
  y: number;
  box: Box | null;
}
/** What a text element and the `<tspan>`s in it take up. Each line, a `x`
 *  or a `y` starts a new one, is anchored by itself. */
function textBox(el: Element, measure: SvgMeasure): Box | null {
  const pen: Pen = { x: 0, y: 0, box: null };
  const anchorOf = (at: Element): string => {
    for (let up: AnyNode | null = at; up; up = up.parent) {
      if (up instanceof Element) {
        const a = attr(up, 'text-anchor');
        if (a) return a;
      }
    }
    return 'start';
  };
  const place = (at: Element): void => {
    const em = measure.fontSize(at);
    const x = attr(at, 'x');
    const y = attr(at, 'y');
    if (x !== undefined) pen.x = numbers(x)[0] ?? 0;
    if (y !== undefined) pen.y = numbers(y)[0] ?? 0;
    pen.x += length(attr(at, 'dx')?.split(/[\s,]+/)[0], em, 0);
    pen.y += length(attr(at, 'dy')?.split(/[\s,]+/)[0], em, 0);
    for (const kid of at.children) {
      if (kid instanceof Text) {
        const data = kid.data.replace(/\s+/g, ' ');
        if (!data.trim()) continue;
        const run = measure.text(at, data.trim());
        const anchor = anchorOf(at);
        const start =
          anchor === 'middle'
            ? pen.x - run.width / 2
            : anchor === 'end'
              ? pen.x - run.width
              : pen.x;
        pen.box = union(pen.box, {
          x: start,
          y: pen.y - run.ascent,
          width: run.width,
          height: run.ascent + run.descent,
        });
        pen.x += run.width;
      } else if (kid instanceof Element) place(kid);
    }
  };
  place(el);
  return pen.box;
}

/** `getBBox` (SVG 2, 8.10): what an element takes up in its own user units,
 *  a child's through its transform, and no stroke. */
export function bboxOf(el: Element, measure: SvgMeasure): Box | null {
  const name = tag(el);
  const em = measure.fontSize(el);
  switch (name) {
    case 'text':
    case 'tspan':
    case 'textpath':
      return textBox(el, measure);
    case 'path':
    case 'rect':
    case 'circle':
    case 'ellipse':
    case 'line':
    case 'polyline':
    case 'polygon': {
      let box: Box | null = null;
      for (const line of shapeLines(el, measure)) {
        for (let i = 0; i + 1 < line.length; i += 2) {
          box = union(box, { x: line[i], y: line[i + 1], width: 0, height: 0 });
        }
      }
      // a shape with no area is a shape not drawn, and not one at its corner
      const flat = /^(rect|circle|ellipse)$/.test(name);
      return flat && box && !(box.width > 0 && box.height > 0) ? null : box;
    }
    case 'image':
    case 'foreignobject': {
      return {
        x: length(attr(el, 'x'), em, 0),
        y: length(attr(el, 'y'), em, 0),
        width: length(attr(el, 'width'), em, 0),
        height: length(attr(el, 'height'), em, 0),
      };
    }
    default: {
      let box: Box | null = null;
      for (const kid of kids(el)) {
        if (/^(title|desc|metadata|style|script)$/i.test(kid.name)) continue;
        if (unrendered(kid, measure)) continue;
        const inner = bboxOf(kid, measure);
        if (inner) box = union(box, through(ownTransform(kid), inner));
      }
      return box;
    }
  }
}
/** Where an element is drawn, in the document's CSS pixels. */
export function drawnBox(el: Element, measure: SvgMeasure): Box | null {
  const box = bboxOf(el, measure);
  const ctm = screenCtmOf(el, measure);
  return box && ctm ? through(ctm, box) : null;
}

/** What the facade asks of a drawing, as the numbers it reads back. */
export function svgAnswer(
  question: string,
  el: Element,
  measure: SvgMeasure,
  distance: number,
): readonly number[] | null {
  const box = (b: Box | null): number[] | null =>
    b && [b.x, b.y, b.width, b.height];
  switch (question) {
    case 'bbox':
      return box(unrendered(el, measure) ? null : bboxOf(el, measure));
    case 'drawn':
      return box(drawnBox(el, measure));
    case 'ctm':
      return ctmOf(el, measure);
    case 'screenCtm':
      return screenCtmOf(el, measure);
    case 'length':
      return [totalLength(shapeLines(el, measure))];
    case 'point':
      return pointAt(shapeLines(el, measure), distance);
    case 'textLength':
      return [measure.text(el, el.children.map(textOf).join('')).width];
    default:
      return null;
  }
}
/** All the text under a node. */
function textOf(node: AnyNode): string {
  if (node instanceof Text) return node.data;
  return node instanceof Element ? node.children.map(textOf).join('') : '';
}
