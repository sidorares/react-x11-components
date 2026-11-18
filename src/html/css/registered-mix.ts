// What a registered custom property comes to between two of its values
// (CSS Properties and Values 1, 2.6): a property registered with a syntax
// whose type interpolates — a number, an integer, a length, a percentage,
// a length-percentage, an angle, a time, a resolution or a colour, or a
// list of one of them — is interpolated as that type, and added as it,
// where an unregistered one goes over half-way. Values are read as their
// computed forms are written (`100px`, `150deg`, `rgb(…)`), and written
// back so.
import { parseColor } from './values.js';

/** One value of a type, as numbers: a dimension's in its canonical unit,
 *  a length-percentage's as its length and its percentage, a colour's
 *  premultiplied channels and its alpha. */
type Part =
  | { type: 'number' | 'integer'; n: number }
  | { type: 'dimension'; n: number; unit: string }
  | { type: 'length-percentage'; px: number; pct: number }
  | { type: 'color'; r: number; g: number; b: number; a: number };

/** Each dimension type's units, as the factor to its canonical one, which
 *  its computed value is written in. */
const UNITS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  length: { px: 1 },
  percentage: { '%': 1 },
  angle: { deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 },
  time: { s: 1, ms: 0.001 },
  resolution: { dppx: 1, x: 1, dpi: 1 / 96, dpcm: 2.54 / 96 },
};
const CANONICAL: Readonly<Record<string, string>> = {
  length: 'px',
  percentage: '%',
  angle: 'deg',
  time: 's',
  resolution: 'dppx',
};

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;

/** One value of `type`, or null where it is none. */
function readPart(type: string, text: string): Part | null {
  const v = text.trim();
  if (type === 'number' || type === 'integer') {
    const m = NUMBER.exec(v);
    if (!m || m[0].length !== v.length) return null;
    const n = Number(m[0]);
    if (type === 'integer' && !Number.isInteger(n)) return null;
    return { type, n };
  }
  if (type === 'color') {
    const color = parseColor(v);
    const rgba = color === null ? null : channels(color);
    if (!rgba) return null;
    const [r, g, b, a] = rgba;
    return { type, r: r * a, g: g * a, b: b * a, a };
  }
  if (type === 'length-percentage') {
    const one = readPart('length', v) ?? readPart('percentage', v);
    if (one && one.type === 'dimension') {
      return one.unit === '%'
        ? { type, px: 0, pct: one.n }
        : { type, px: one.n, pct: 0 };
    }
    // `calc(P% + Lpx)`, as one is written back
    const m =
      /^calc\(\s*([+-]?[\d.e+-]+)%\s*([+-])\s*([\d.e+-]+)px\s*\)$/i.exec(v);
    if (!m) return null;
    const px = Number(m[3]) * (m[2] === '-' ? -1 : 1);
    const pct = Number(m[1]);
    return Number.isFinite(px) && Number.isFinite(pct)
      ? { type, px, pct }
      : null;
  }
  const units = UNITS[type];
  if (!units) return null;
  const m = NUMBER.exec(v);
  if (!m) return null;
  const unit = v.slice(m[0].length).toLowerCase();
  const factor = units[unit];
  if (factor === undefined) return null;
  return { type: 'dimension', n: Number(m[0]) * factor, unit: CANONICAL[type] };
}

/** A colour as `parseColor` writes it, its channels 0–255 and its alpha. */
function channels(color: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(color);
  if (!fn) return null;
  const parts = fn[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

/** A number as CSS serializes it, to six decimal places. */
function num(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

function writePart(part: Part): string {
  switch (part.type) {
    case 'number':
      return num(part.n);
    case 'integer':
      return String(Math.round(part.n));
    case 'dimension':
      return `${num(part.n)}${part.unit}`;
    case 'length-percentage': {
      if (part.pct === 0) return `${num(part.px)}px`;
      if (part.px === 0) return `${num(part.pct)}%`;
      const sign = part.px < 0 ? '-' : '+';
      return `calc(${num(part.pct)}% ${sign} ${num(Math.abs(part.px))}px)`;
    }
    case 'color': {
      const a = Math.max(0, Math.min(1, part.a));
      const un = (c: number) =>
        Math.round(Math.max(0, Math.min(255, a ? c / a : 0)));
      const rgb = `${un(part.r)}, ${un(part.g)}, ${un(part.b)}`;
      return a === 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${num(a)})`;
    }
  }
}

/** `a` and `b` of one type, `wa` and `wb` of each: a mix (weights summing
 *  to 1) or a sum (both 1). Null where they are not of one kind. */
function combine(a: Part, b: Part, wa: number, wb: number): Part | null {
  if (a.type !== b.type) return null;
  if (a.type === 'number' || a.type === 'integer') {
    return { type: a.type, n: a.n * wa + (b as typeof a).n * wb };
  }
  if (a.type === 'dimension') {
    const other = b as typeof a;
    if (other.unit !== a.unit) return null;
    return { type: a.type, n: a.n * wa + other.n * wb, unit: a.unit };
  }
  if (a.type === 'length-percentage') {
    const other = b as typeof a;
    return {
      type: a.type,
      px: a.px * wa + other.px * wb,
      pct: a.pct * wa + other.pct * wb,
    };
  }
  const own = a as Extract<Part, { type: 'color' }>;
  const other = b as Extract<Part, { type: 'color' }>;
  return {
    type: 'color',
    r: own.r * wa + other.r * wb,
    g: own.g * wa + other.g * wb,
    b: own.b * wa + other.b * wb,
    a: own.a * wa + other.a * wb,
  };
}

/** A syntax's interpolable shape: one type, alone or in a list. Null for
 *  a syntax that does not interpolate (`*`, an ident, an image, a
 *  transform, a combination). */
function shapeOf(
  syntax: string,
): { type: string; list: '' | ' ' | ',' } | null {
  const m = /^\s*<([a-z-]+)>\s*([+#]?)\s*$/.exec(syntax);
  if (!m) return null;
  const type = m[1];
  if (
    !/^(?:number|integer|length|percentage|length-percentage|angle|time|resolution|color)$/.test(
      type,
    )
  ) {
    return null;
  }
  return { type, list: m[2] === '+' ? ' ' : m[2] === '#' ? ',' : '' };
}

function readList(
  shape: { type: string; list: '' | ' ' | ',' },
  text: string,
): Part[] | null {
  const items = shape.list
    ? text
        .trim()
        .split(shape.list === ',' ? /\s*,\s*/ : /\s+(?![^(]*\))/)
        .filter(Boolean)
    : [text];
  const out: Part[] = [];
  for (const item of items) {
    const part = readPart(shape.type, item);
    if (!part) return null;
    out.push(part);
  }
  return out;
}

function zip(
  syntax: string,
  a: string,
  b: string,
  wa: number,
  wb: number,
): string | null {
  const shape = shapeOf(syntax);
  if (!shape) return null;
  const x = readList(shape, a);
  const y = readList(shape, b);
  if (!x || !y || x.length !== y.length) return null;
  const out: string[] = [];
  for (let i = 0; i < x.length; i += 1) {
    const part = combine(x[i], y[i], wa, wb);
    if (!part) return null;
    out.push(writePart(part));
  }
  return out.join(shape.list === ',' ? ', ' : ' ');
}

/** A registered property's value `q` of the way from `a` to `b`, or null
 *  where its syntax does not interpolate or the two are not alike. */
export function mixRegistered(
  syntax: string,
  a: string,
  b: string,
  q: number,
): string | null {
  return zip(syntax, a, b, 1 - q, q);
}

/** `value` added onto `under` (Web Animations 1, 5.4.4): the sum, where
 *  the syntax interpolates and the two are alike, and null otherwise. */
export function addRegistered(
  syntax: string,
  under: string,
  value: string,
): string | null {
  return zip(syntax, under, value, 1, 1);
}

/** Whether a syntax is one `mixRegistered` interpolates. */
export function mixesRegistered(syntax: string): boolean {
  return shapeOf(syntax) !== null;
}
