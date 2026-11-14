// `shape-outside`, `shape-margin` and `shape-image-threshold` (CSS Shapes 1,
// 6), and the basic shapes they and `clip-path` take (3.1, and CSS Shapes 2,
// 4.1), as `el.style` keeps them and as `getComputedStyle` reads them:
//
// - specified (`*Specified`): each function's arguments in their canonical
//   form — a `<position>` horizontal first and of two values or four, a
//   radius that is the default left out, `inset()`'s sides and radii as
//   short as they go, `nonzero` and `round 0` dropped, path data spelled out
//   — and the reference box after the shape, `margin-box` left out; null for
//   what is no value of the property;
// - computed: `shape-margin` and `shape-image-threshold` here; a shape is
//   read as `clip-path` reads one (`parseClipPath`), so it animates as one,
//   and `computed.ts` writes it out (`shapeOutsideText`), lengths in pixels,
//   a position as the two length-percentages it comes to, `rect()` and
//   `xywh()` as the `inset()` they are, path data absolute (`pathText`).
//
// What floats lay their lines out along is not worked out here: layout does
// not read the shape, so a float's box is what lines go around.

import { serializeMath } from './calc-tree.js';
import { parseShapeFunction } from './shape-function.js';
import { parseLength, splitCommas, splitValue } from './values.js';
import type { Len, UnitContext } from './values.js';

/** What a value is read against where it is only checked. */
const CHECK: UnitContext = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };
const SHAPE_BOXES = /^(margin-box|border-box|padding-box|content-box)$/i;
const CSS_WIDE = /^(inherit|initial|unset|revert|revert-layer)$/i;
const MATH = /^(?:calc|min|max|clamp|round|mod|rem|abs|sign)\(/i;
const DIMENSION = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|[a-z]+)?$/i;
const LENGTH_UNITS = new Set([
  'px',
  'em',
  'ex',
  'ch',
  'ic',
  'cap',
  'lh',
  'rlh',
  'rem',
  'vw',
  'vh',
  'vi',
  'vb',
  'vmin',
  'vmax',
  'svw',
  'svh',
  'lvw',
  'lvh',
  'dvw',
  'dvh',
  'cqw',
  'cqh',
  'cqi',
  'cqb',
  'cqmin',
  'cqmax',
  'cm',
  'mm',
  'q',
  'in',
  'pt',
  'pc',
]);

/** A number as CSS writes one: six figures, no `+`, `-0` as `0`. */
const num = (n: number): string => {
  const r = Number(n.toPrecision(6));
  return Object.is(r, -0) ? '0' : String(r);
};

// --- one length-percentage ---------------------------------------------------

/** A `<length-percentage>` as `el.style` keeps it, or null. `0` is `0px`,
 *  a calculation is simplified. */
function lpSpecified(token: string, positive = false): string | null {
  const t = token.trim();
  if (MATH.test(t)) {
    if (parseLength(t, CHECK) === null) return null;
    return serializeMath(t) ?? null;
  }
  const m = DIMENSION.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (positive && n < 0) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (!unit) return n === 0 ? '0px' : null;
  if (unit !== '%' && !LENGTH_UNITS.has(unit)) return null;
  return num(n) + unit;
}
/** A `<length-percentage>` read against an element, or null. */
function lpOf(token: string, ctx: UnitContext): Len | null {
  const t = token.trim();
  if (!MATH.test(t) && lpSpecified(t) === null) return null;
  const v = parseLength(t, ctx);
  return v === null || v === 'auto' ? null : v;
}
// --- a position -----------------------------------------------------------------

const ACROSS = new Set(['left', 'right']);
const DOWN = new Set(['top', 'bottom']);
const KEYWORDS = new Set(['left', 'right', 'top', 'bottom', 'center']);
interface Position {
  /** The keyword each axis goes by, or null for an offset alone. */
  hk: string | null;
  ho: string | null;
  vk: string | null;
  vo: string | null;
}
/** A `<position>` as basic shapes take it (CSS Values 4, 9.1): one value,
 *  two, or four, never three. */
function positionOf(parts: string[]): Position | null {
  const w = parts.map((p) => p.toLowerCase());
  const lp = (i: number): boolean =>
    !KEYWORDS.has(w[i]) && lpSpecified(parts[i]) !== null;
  if (parts.length === 1) {
    if (ACROSS.has(w[0]) || w[0] === 'center')
      return { hk: w[0], ho: null, vk: 'center', vo: null };
    if (DOWN.has(w[0])) return { hk: 'center', ho: null, vk: w[0], vo: null };
    return lp(0) ? { hk: null, ho: parts[0], vk: 'center', vo: null } : null;
  }
  if (parts.length === 2) {
    let [a, b] = [0, 1];
    // a vertical keyword first, with a horizontal or `center` after it
    if (
      (DOWN.has(w[0]) && (ACROSS.has(w[1]) || w[1] === 'center')) ||
      (w[0] === 'center' && ACROSS.has(w[1]))
    ) {
      [a, b] = [1, 0];
    }
    const h = w[a];
    const v = w[b];
    const hOk = ACROSS.has(h) || h === 'center' || lp(a);
    const vOk = DOWN.has(v) || v === 'center' || lp(b);
    if (!hOk || !vOk) return null;
    return {
      hk: KEYWORDS.has(h) ? h : null,
      ho: KEYWORDS.has(h) ? null : parts[a],
      vk: KEYWORDS.has(v) ? v : null,
      vo: KEYWORDS.has(v) ? null : parts[b],
    };
  }
  if (parts.length === 4) {
    let [a, b, c, d] = [0, 1, 2, 3];
    if (DOWN.has(w[0]) && ACROSS.has(w[2])) [a, b, c, d] = [2, 3, 0, 1];
    if (!ACROSS.has(w[a]) || !DOWN.has(w[c]) || !lp(b) || !lp(d)) return null;
    return { hk: w[a], ho: parts[b], vk: w[c], vo: parts[d] };
  }
  return null;
}
const positionSpecified = (p: Position): string => {
  const side = (k: string | null, o: string | null): string =>
    [k, o === null ? null : lpSpecified(o)].filter(Boolean).join(' ');
  return `${side(p.hk, p.ho)} ${side(p.vk, p.vo)}`;
};
// --- the basic shapes -------------------------------------------------------------

/** A shape's text as `el.style` keeps it. */
interface Shape {
  specified: string;
}

/** Four sides, or radii, as short as they go. */
const shortest = (v: string[]): string[] => {
  const [t, r, b, l] = v;
  if (l !== r) return [t, r, b, l];
  if (b !== t) return [t, r, b];
  if (r !== t) return [t, r];
  return [t];
};
const fourOf = <T>(v: T[]): T[] =>
  v.length === 1
    ? [v[0], v[0], v[0], v[0]]
    : v.length === 2
      ? [v[0], v[1], v[0], v[1]]
      : v.length === 3
        ? [v[0], v[1], v[2], v[1]]
        : v;

/** `round <border-radius>` (CSS Shapes 1, 3.1), its two lists of up to
 *  four, as tokens; null for what is none. */
function radiiOf(parts: string[]): [string[], string[]] | null {
  const slash = parts.indexOf('/');
  const across = slash < 0 ? parts : parts.slice(0, slash);
  const down = slash < 0 ? across : parts.slice(slash + 1);
  if (!across.length || across.length > 4 || !down.length || down.length > 4) {
    return null;
  }
  if ([...across, ...down].some((p) => lpSpecified(p, true) === null))
    return null;
  return [fourOf(across), fourOf(down)];
}
const radiiText = (
  [across, down]: [string[], string[]],
  text: (t: string) => string,
): string => {
  const a = shortest(across.map(text));
  const d = shortest(down.map(text));
  return a.join(' ') === d.join(' ')
    ? a.join(' ')
    : `${a.join(' ')} / ${d.join(' ')}`;
};

function circleOrEllipse(fn: string, inner: string): Shape | null {
  const parts = splitValue(inner);
  const at = parts.findIndex((p) => p.toLowerCase() === 'at');
  const radii = at < 0 ? parts : parts.slice(0, at);
  const want = fn === 'circle' ? 1 : 2;
  if (radii.length && radii.length !== want) return null;
  const pos = at < 0 ? null : positionOf(parts.slice(at + 1));
  if (at >= 0 && !pos) return null;
  const sides = radii.map((r) => {
    const w = r.toLowerCase();
    return w === 'closest-side' || w === 'farthest-side'
      ? w
      : lpSpecified(r, true);
  });
  if (sides.some((s) => s === null)) return null;
  // the default radii are left out
  const drop = sides.every((s) => s === 'closest-side');
  const head = drop ? [] : (sides as string[]);
  const specified = `${fn}(${[...head, ...(pos ? ['at', positionSpecified(pos)] : [])].join(' ')})`;
  return { specified };
}

/** `inset()`, `rect()` and `xywh()`: four lengths and the corners. */
function boxShape(fn: string, inner: string): Shape | null {
  const parts = splitValue(inner);
  const round = parts.findIndex((p) => p.toLowerCase() === 'round');
  const sides = round < 0 ? parts : parts.slice(0, round);
  const radii = round < 0 ? null : radiiOf(parts.slice(round + 1));
  if (round >= 0 && !radii) return null;
  const want = fn === 'inset' ? [1, 4] : [4, 4];
  if (sides.length < want[0] || sides.length > want[1]) return null;
  const specSides = sides.map((s, i) =>
    fn === 'rect' && s.toLowerCase() === 'auto'
      ? 'auto'
      : lpSpecified(s, fn === 'xywh' && i >= 2),
  );
  if (specSides.some((s) => s === null)) return null;
  const roundText = radii
    ? ` round ${radiiText(radii, (t) => lpSpecified(t, true)!)}`
    : '';
  const specified =
    fn === 'inset'
      ? `inset(${shortest(fourOf(specSides as string[])).join(' ')}${roundText})`
      : `${fn}(${(specSides as string[]).join(' ')}${roundText})`;
  return { specified };
}

function polygon(inner: string): Shape | null {
  const args = splitCommas(inner).map((a) => a.trim());
  let rule = 'nonzero';
  let round: string | null = null;
  // a fill rule, `round <length>`, or both, before the points
  const head = splitValue(args[0] ?? '');
  const lead = head[0]?.toLowerCase();
  if (lead === 'nonzero' || lead === 'evenodd' || lead === 'round') {
    let i = 0;
    if (lead === 'nonzero' || lead === 'evenodd') {
      rule = lead;
      i = 1;
    }
    if (head[i]?.toLowerCase() === 'round') {
      if (head.length !== i + 2) return null;
      round = head[i + 1];
      if (lpSpecified(round, true) === null || /%$/.test(round.trim()))
        return null;
    } else if (head.length !== i) return null;
    args.shift();
  }
  if (!args.length) return null;
  const points: string[][] = [];
  for (const arg of args) {
    const pair = splitValue(arg);
    if (pair.length !== 2 || pair.some((p) => lpSpecified(p) === null))
      return null;
    points.push(pair);
  }
  const roundSpec = round === null ? null : lpSpecified(round, true)!;
  const lead2 = [
    rule === 'evenodd' ? 'evenodd' : null,
    roundSpec && roundSpec !== '0px' ? `round ${roundSpec}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const pts = points.map((p) => p.map((t) => lpSpecified(t)!).join(' '));
  return {
    specified: `polygon(${[lead2, ...pts].filter(Boolean).join(', ')})`,
  };
}

// --- path data --------------------------------------------------------------------

const PATH_ARGS: Record<string, number> = {
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
const PATH_NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
/** Path data's segments, a repeated command spelled out, or null where any
 *  of it is not path data or there is none. */
export function pathSegments(text: string): Array<[string, number[]]> | null {
  const out: Array<[string, number[]]> = [];
  let i = 0;
  const n = text.length;
  const space = (): void => {
    while (i < n && /[\s,]/.test(text[i])) i++;
  };
  space();
  let cmd = '';
  while (i < n) {
    const ch = text[i];
    if (/[A-Za-z]/.test(ch)) {
      if (!(ch.toUpperCase() in PATH_ARGS)) return null;
      if (!out.length && ch !== 'M' && ch !== 'm') return null;
      cmd = ch;
      i++;
    } else if (!cmd || cmd === 'Z' || cmd === 'z') return null;
    const up = cmd.toUpperCase();
    const args: number[] = [];
    for (let k = 0; k < PATH_ARGS[up]; k++) {
      space();
      if (up === 'A' && (k === 3 || k === 4)) {
        if (text[i] !== '0' && text[i] !== '1') return null;
        args.push(+text[i++]);
        continue;
      }
      PATH_NUMBER.lastIndex = i;
      const m = PATH_NUMBER.exec(text);
      if (!m) return null;
      i += m[0].length;
      args.push(+m[0]);
    }
    out.push([cmd, args]);
    if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    space();
  }
  return out.length ? out : null;
}
/** Path data as Chromium writes it: as written, or every command absolute
 *  (`computed`). */
export function pathText(
  segs: Array<[string, number[]]>,
  absolute: boolean,
): string {
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  return segs
    .map(([cmd, a], i) => {
      const up = cmd.toUpperCase();
      if (up === 'Z') {
        x = sx;
        y = sy;
        return 'Z';
      }
      const rel = cmd !== up && i > 0;
      const abs = a.slice();
      if (rel) {
        if (up === 'H') abs[0] += x;
        else if (up === 'V') abs[0] += y;
        else if (up === 'A') {
          abs[5] += x;
          abs[6] += y;
        } else {
          for (let k = 0; k < abs.length; k += 2) {
            abs[k] += x;
            abs[k + 1] += y;
          }
        }
      }
      if (up === 'H') x = abs[0];
      else if (up === 'V') y = abs[0];
      else {
        x = abs[abs.length - 2];
        y = abs[abs.length - 1];
      }
      if (up === 'M') {
        sx = x;
        sy = y;
      }
      return absolute
        ? [up, ...abs.map(num)].join(' ')
        : [i === 0 && cmd === 'm' ? 'M' : cmd, ...a.map(num)].join(' ');
    })
    .join(' ');
}
function pathShape(inner: string): Shape | null {
  const args = splitCommas(inner).map((a) => a.trim());
  let rule = 'nonzero';
  if (args.length === 2) {
    const r = args[0].toLowerCase();
    if (r !== 'nonzero' && r !== 'evenodd') return null;
    rule = r;
    args.shift();
  }
  if (args.length !== 1) return null;
  const m = /^(["'])([^]*)\1$/.exec(args[0]);
  if (!m) return null;
  const segs = pathSegments(m[2]);
  if (!segs) return null;
  const head = rule === 'evenodd' ? 'evenodd, ' : '';
  return {
    specified: `path(${head}"${pathText(segs, false)}")`,
  };
}

/** A basic shape, or null where `text` is none. */
function basicShape(text: string): Shape | null {
  const m = /^([a-z-]+)\(([^]*)\)$/i.exec(text.trim());
  if (!m) return null;
  const fn = m[1].toLowerCase();
  const inner = m[2];
  switch (fn) {
    case 'circle':
    case 'ellipse':
      return circleOrEllipse(fn, inner);
    case 'inset':
    case 'rect':
    case 'xywh':
      return boxShape(fn, inner);
    case 'polygon':
      return polygon(inner);
    case 'path':
      return pathShape(inner);
    case 'shape': {
      const read = parseShapeFunction(text, CHECK);
      if (!read) return null;
      return {
        specified: read.text,
      };
    }
    default:
      return null;
  }
}

/** A shape and a box, in either order, or either alone. */
function shapeAndBox(
  value: string,
): { shape: Shape | null; box: string | null } | null {
  const parts = splitValue(value.trim());
  if (!parts.length || parts.length > 2) return null;
  let shape: Shape | null = null;
  let box: string | null = null;
  for (const part of parts) {
    if (SHAPE_BOXES.test(part)) {
      if (box) return null;
      box = part.toLowerCase();
    } else {
      if (shape) return null;
      shape = basicShape(part);
      if (!shape) return null;
    }
  }
  return { shape, box };
}
const IMAGE =
  /^(?:url|image|image-set|cross-fade|element|(?:repeating-)?(?:linear|radial|conic)-gradient|-webkit-[a-z-]*gradient)\(/i;

// --- the properties ---------------------------------------------------------------

/** `shape-outside` as `el.style` keeps it; undefined where it is kept as
 *  written (an image, a keyword every property takes). */
export function shapeOutsideSpecified(
  value: string,
): string | null | undefined {
  const v = value.trim();
  if (CSS_WIDE.test(v)) return undefined;
  if (/^none$/i.test(v)) return 'none';
  if (IMAGE.test(v)) return undefined;
  const read = shapeAndBox(v);
  if (!read) return null;
  return boxed(read.shape?.specified ?? null, read.box);
}
const boxed = (shape: string | null, box: string | null): string =>
  shape === null
    ? (box ?? 'margin-box')
    : box && box !== 'margin-box'
      ? `${shape} ${box}`
      : shape;

/** A basic shape as `clip-path` keeps it, beside a box; undefined for what
 *  is not one, which `specified.ts` keeps as before. */
export function basicShapeSpecified(value: string): string | null | undefined {
  const v = value.trim();
  const fn = /^([a-z-]+)\(/i.exec(v)?.[1]?.toLowerCase();
  if (!fn || !/^(circle|ellipse|inset|rect|xywh|polygon|path)$/.test(fn)) {
    return undefined;
  }
  const parts = splitValue(v);
  let shape: Shape | null = null;
  let box: string | null = null;
  for (const part of parts) {
    if (
      /^(margin-box|border-box|padding-box|content-box|fill-box|stroke-box|view-box)$/i.test(
        part,
      )
    ) {
      if (box) return null;
      box = part.toLowerCase();
    } else {
      if (shape) return null;
      shape = basicShape(part);
      if (!shape) return null;
    }
  }
  if (!shape) return null;
  return box && box !== 'border-box'
    ? `${shape.specified} ${box}`
    : shape.specified;
}

/** `shape-margin`: a length-percentage not below nought. */
export function shapeMarginSpecified(value: string): string | null | undefined {
  const v = value.trim();
  if (CSS_WIDE.test(v)) return undefined;
  return lpSpecified(v, true);
}
export function shapeMarginComputed(
  value: string,
  ctx: UnitContext,
): Len | undefined {
  if (lpSpecified(value.trim(), true) === null) return undefined;
  return lpOf(value, ctx) ?? undefined;
}

/** `shape-image-threshold`: a number, or a percentage that is one. */
function threshold(value: string): number | null {
  const v = value.trim();
  if (MATH.test(v)) {
    const inner = /^calc\(\s*([-+]?[\d.]+)\s*\/\s*([-+]?[\d.]+)\s*\)$/i.exec(v);
    if (inner) return Number(inner[1]) / Number(inner[2]);
    const one = /^calc\(\s*([-+]?(?:\d+\.?\d*|\.\d+))(%?)\s*\)$/i.exec(v);
    return one ? Number(one[1]) / (one[2] ? 100 : 1) : null;
  }
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(v);
  if (!m) return null;
  return Number(m[1]) / (m[2] ? 100 : 1);
}
export function shapeThresholdSpecified(
  value: string,
): string | null | undefined {
  const v = value.trim();
  if (CSS_WIDE.test(v)) return undefined;
  if (MATH.test(v))
    return threshold(v) === null ? null : (serializeMath(v) ?? null);
  const n = threshold(v);
  return n === null ? null : num(n);
}
/** `shape-image-threshold` as it computes: between nought and one. */
export function shapeThresholdComputed(value: string): number | undefined {
  const n = threshold(value);
  return n === null ? undefined : Math.min(1, Math.max(0, n));
}

/** Whether a value is an image `shape-outside` takes, kept as written. */
export const isShapeImage = (value: string): boolean =>
  IMAGE.test(value.trim());
/** Whether a value names a reference box. */
export const namesShapeBox = (value: string): boolean =>
  splitValue(value.trim()).some((p) => SHAPE_BOXES.test(p));
/** Whether a circle or an ellipse in a value says where it is. */
export const saysWhere = (value: string): boolean =>
  /(?:^|[\s(])at(?=[\s)])/i.test(value);
