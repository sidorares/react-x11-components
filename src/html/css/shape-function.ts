// `shape()` (CSS Shapes 2, 4.2): a path written in CSS, its points
// positions and lengths of the box it is laid down in, read as the cascade
// reads a value. What it is read into is a plain record of lengths, words
// and flags (`ShapeFunction`), so two shapes of the same commands are
// interpolated as any record of lengths is (`interpolate.ts`), and its
// computed value is written back from it (`computed.ts`). It is laid down
// for a box as SVG path data (`shapePathData`), which `pathPolygons` cuts
// into chords as it cuts `path()`'s.

import { AUTO, parseLength, resolve, splitCommas } from './values.js';
import type { Len, UnitContext } from './values.js';

/** Two lengths from the box's top left, across and down. */
export type Coord = readonly [Len, Len];

/** What a control point is measured from (4.2.1): where the command
 *  starts, where it ends, or the box's top left. */
export type Anchor = 'start' | 'end' | 'origin';

export interface ControlPoint {
  at: Coord;
  from: Anchor;
}

export type ShapeCommand =
  | { op: 'move' | 'line'; by: boolean; to: Coord }
  | { op: 'hline' | 'vline'; by: boolean; to: Len }
  | {
      op: 'curve' | 'smooth';
      by: boolean;
      to: Coord;
      /** One control point or two for a curve, none or one for a smooth
       *  one, whose first is the last one's reflected. */
      with: readonly ControlPoint[];
    }
  | {
      op: 'arc';
      by: boolean;
      to: Coord;
      /** One radius, of the box's diagonal over √2, or two, of its width
       *  and its height. */
      radii: readonly Len[];
      cw: boolean;
      large: boolean;
      /** Degrees. */
      rotate: number;
    }
  | { op: 'close' };

export interface ShapeFunction {
  rule: 'nonzero' | 'evenodd';
  from: Coord;
  commands: readonly ShapeCommand[];
}

/** A shape and its specified value, as `el.style` reads it back: lengths
 *  in the units they were written in, positions written across first, and
 *  what is the default left out. */
export interface ParsedShape {
  shape: ShapeFunction;
  text: string;
}

/** A command's words: white space and a `/` apart, outside parentheses. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  const cut = (end: number) => {
    if (end > start) out.push(text.slice(start, end));
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(c)) {
      cut(i);
      start = i + 1;
    } else if (depth === 0 && c === '/') {
      cut(i);
      out.push('/');
      start = i + 1;
    }
  }
  cut(text.length);
  return out;
}

const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i;

/** A length or a percentage as its specified value writes it: a number
 *  as a number is written, `0` with a unit, and a function as it was. */
function lengthText(word: string): string {
  const m = NUMBER.exec(word);
  if (!m) return word.replace(/\s+/g, ' ');
  const n = String(Number(m[1]));
  const unit = m[2].toLowerCase();
  return unit ? `${n}${unit}` : `${n}px`;
}

/** A length or a percentage, and how its specified value writes it. */
function lengthOf(
  word: string,
  ctx: UnitContext,
): { len: Len; text: string } | null {
  if (/^[a-z-]+$/i.test(word)) return null;
  const len = parseLength(word, ctx);
  if (len === null || len === AUTO) return null;
  return { len, text: lengthText(word) };
}

const ACROSS: Record<string, Len> = {
  left: { pct: 0 },
  center: { pct: 50 },
  right: { pct: 100 },
};
const DOWN: Record<string, Len> = {
  top: { pct: 0 },
  center: { pct: 50 },
  bottom: { pct: 100 },
};

const isAcross = (w: string): boolean => w === 'left' || w === 'right';
const isDown = (w: string): boolean => w === 'top' || w === 'bottom';
const isSide = (w: string): boolean => w in ACROSS || w in DOWN;

/**
 * A `<position>` (CSS Values 4, 9.1), one word to four: the two lengths it
 * comes to from the box's top left, the words its specified value is
 * written in, across first, and whether it is no more than a pair of
 * lengths.
 */
function positionOf(
  words: readonly string[],
  ctx: UnitContext,
): { at: Coord; text: string; pair: boolean } | null {
  const lower = words.map((w) => w.toLowerCase());
  if (words.length === 1) {
    const w = lower[0];
    if (w in ACROSS) {
      return { at: [ACROSS[w], DOWN.center], text: `${w} center`, pair: false };
    }
    if (w in DOWN) {
      return { at: [ACROSS.center, DOWN[w]], text: `center ${w}`, pair: false };
    }
    const len = lengthOf(words[0], ctx);
    if (!len) return null;
    return {
      at: [len.len, DOWN.center],
      text: `${len.text} center`,
      pair: false,
    };
  }
  if (words.length === 2) {
    let [a, b] = lower;
    let [wa, wb] = words;
    // `top left` and `center left` are written down first
    if (isDown(a) || isAcross(b)) {
      if (!(isAcross(b) || b === 'center') || !(isDown(a) || a === 'center')) {
        return null;
      }
      [a, b] = [b, a];
      [wa, wb] = [wb, wa];
    }
    if (isDown(a) || isAcross(b)) return null;
    const x = a in ACROSS ? { len: ACROSS[a], text: a } : lengthOf(wa, ctx);
    const y = b in DOWN ? { len: DOWN[b], text: b } : lengthOf(wb, ctx);
    if (!x || !y) return null;
    return {
      at: [x.len, y.len],
      text: `${x.text} ${y.text}`,
      pair: !(a in ACROSS) && !(b in DOWN),
    };
  }
  if (words.length !== 3 && words.length !== 4) return null;
  // a side each way and how far from it: `right 10px bottom 20px`
  const sides: { word: string; offset: { len: Len; text: string } | null }[] =
    [];
  for (let i = 0; i < words.length;) {
    const word = lower[i];
    if (!isSide(word)) return null;
    let offset: { len: Len; text: string } | null = null;
    if (i + 1 < words.length && !isSide(lower[i + 1])) {
      if (word === 'center') return null;
      offset = lengthOf(words[i + 1], ctx);
      if (!offset) return null;
    }
    sides.push({ word, offset });
    i += offset ? 2 : 1;
  }
  if (sides.length !== 2) return null;
  let [first, second] = sides;
  if (isDown(first.word) || isAcross(second.word))
    [first, second] = [second, first];
  if (isDown(first.word) || isAcross(second.word)) return null;
  // a length from the far side is the side's percentage less it
  const along = (
    side: { word: string; offset: { len: Len } | null },
    far: string,
  ): Len => {
    const off = side.offset?.len ?? 0;
    if (side.word !== far) {
      return side.word === 'center'
        ? { pct: 50 }
        : side.offset
          ? off
          : { pct: 0 };
    }
    if (typeof off === 'number')
      return off ? { pct: 100, px: -off } : { pct: 100 };
    if (off === AUTO || off.of) return off;
    const px = -(off.px ?? 0);
    return px ? { pct: 100 - off.pct, px } : { pct: 100 - off.pct };
  };
  const write = (side: (typeof sides)[number]) =>
    side.offset ? `${side.word} ${side.offset.text}` : side.word;
  return {
    at: [along(first, 'right'), along(second, 'bottom')],
    text: `${write(first)} ${write(second)}`,
    pair: false,
  };
}

/** A pair of lengths, the only point a `by` command takes. */
function pairOf(
  words: readonly string[],
  ctx: UnitContext,
): { at: Coord; text: string } | null {
  if (words.length !== 2) return null;
  const x = lengthOf(words[0], ctx);
  const y = lengthOf(words[1], ctx);
  return x && y ? { at: [x.len, y.len], text: `${x.text} ${y.text}` } : null;
}

/** An angle in degrees; null for anything that is none. */
function angleOf(word: string): number | null {
  const m = NUMBER.exec(word);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 'deg':
      return n;
    case 'rad':
      return (n * 180) / Math.PI;
    case 'grad':
      return n * 0.9;
    case 'turn':
      return n * 360;
    case '':
      return n === 0 ? 0 : null;
    default:
      return null;
  }
}

/**
 * A command's words read: its record and its specified text, or null for
 * one that is no command (CSS Shapes 2, 4.2). `smooth` and `curve` are told
 * their control points after `with`, `/` between two; an `arc` its radii
 * after `of`, and its sweep, its size and its turn in any order, once each.
 */
function commandOf(
  words: readonly string[],
  ctx: UnitContext,
): { command: ShapeCommand; text: string } | null {
  const op = words[0]?.toLowerCase();
  if (op === 'close') {
    return words.length === 1 ? { command: { op }, text: 'close' } : null;
  }
  const how = words[1]?.toLowerCase();
  if (how !== 'to' && how !== 'by') return null;
  const by = how === 'by';
  if (op === 'hline' || op === 'vline') {
    if (words.length !== 3) return null;
    const word = words[2].toLowerCase();
    const keywords: Record<string, Len> =
      op === 'hline'
        ? {
            left: { pct: 0 },
            center: { pct: 50 },
            right: { pct: 100 },
            'x-start': { pct: 0 },
            'x-end': { pct: 100 },
          }
        : {
            top: { pct: 0 },
            center: { pct: 50 },
            bottom: { pct: 100 },
            'y-start': { pct: 0 },
            'y-end': { pct: 100 },
          };
    if (!by && word in keywords) {
      return {
        command: { op, by, to: keywords[word] },
        text: `${op} to ${word}`,
      };
    }
    const len = lengthOf(words[2], ctx);
    if (!len) return null;
    return {
      command: { op, by, to: len.len },
      text: `${op} ${how} ${len.text}`,
    };
  }
  if (
    op !== 'move' &&
    op !== 'line' &&
    op !== 'curve' &&
    op !== 'smooth' &&
    op !== 'arc'
  ) {
    return null;
  }
  // where the end point's words end: at `with`, or at an arc's first word
  const ARC_WORDS = new Set(['of', 'cw', 'ccw', 'large', 'small', 'rotate']);
  let end = 2;
  while (
    end < words.length &&
    !(op !== 'arc' && words[end].toLowerCase() === 'with') &&
    !(op === 'arc' && ARC_WORDS.has(words[end].toLowerCase()))
  ) {
    end += 1;
  }
  const point = by
    ? pairOf(words.slice(2, end), ctx)
    : positionOf(words.slice(2, end), ctx);
  if (!point) return null;
  const head = `${op} ${how} ${point.text}`;
  const rest = words.slice(end);
  if (op === 'move' || op === 'line') {
    return rest.length
      ? null
      : { command: { op, by, to: point.at }, text: head };
  }
  if (op === 'curve' || op === 'smooth') {
    if (!rest.length) {
      return op === 'smooth'
        ? { command: { op, by, to: point.at, with: [] }, text: head }
        : null;
    }
    // `with`, then one control point, or two with a `/` between
    const groups: string[][] = [[]];
    for (const w of rest.slice(1)) {
      if (w === '/') groups.push([]);
      else groups[groups.length - 1].push(w);
    }
    if (groups.length > (op === 'curve' ? 2 : 1)) return null;
    const controls: ControlPoint[] = [];
    const texts: string[] = [];
    for (const group of groups) {
      const control = controlOf(group, by, ctx);
      if (!control) return null;
      controls.push(control.point);
      texts.push(control.text);
    }
    return {
      command: { op, by, to: point.at, with: controls },
      text: `${head} with ${texts.join(' / ')}`,
    };
  }
  // an arc's radii, its sweep, its size and its turn, in any order
  let radii: { len: Len; text: string }[] | null = null;
  let cw: boolean | null = null;
  let large: boolean | null = null;
  let rotate: { deg: number; text: string } | null = null;
  for (let i = 0; i < rest.length;) {
    const w = rest[i].toLowerCase();
    if (w === 'of') {
      if (radii) return null;
      radii = [];
      i += 1;
      while (i < rest.length && radii.length < 2) {
        const len = lengthOf(rest[i], ctx);
        if (!len) break;
        radii.push(len);
        i += 1;
      }
      if (!radii.length) return null;
    } else if (w === 'cw' || w === 'ccw') {
      if (cw !== null) return null;
      cw = w === 'cw';
      i += 1;
    } else if (w === 'large' || w === 'small') {
      if (large !== null) return null;
      large = w === 'large';
      i += 1;
    } else if (w === 'rotate') {
      if (rotate || i + 1 >= rest.length) return null;
      const deg = angleOf(rest[i + 1]);
      if (deg === null) return null;
      rotate = { deg, text: lengthText(rest[i + 1]) };
      i += 2;
    } else return null;
  }
  if (!radii) return null;
  let text = `${head} of ${radii.map((r) => r.text).join(' ')}`;
  if (cw) text += ' cw';
  if (large) text += ' large';
  if (rotate && rotate.deg !== 0) text += ` rotate ${rotate.text}`;
  return {
    command: {
      op,
      by,
      to: point.at,
      radii: radii.map((r) => r.len),
      cw: !!cw,
      large: !!large,
      rotate: rotate?.deg ?? 0,
    },
    text,
  };
}

/**
 * A control point (4.2.1): a pair of lengths from where the command starts,
 * from where it ends, or from the box's corner — what `from` names, and the
 * start for a `by` command and the corner for a `to` one where it names
 * none — or, for a `to` command alone, a position in the box.
 */
function controlOf(
  words: readonly string[],
  by: boolean,
  ctx: UnitContext,
): { point: ControlPoint; text: string } | null {
  const fallback: Anchor = by ? 'start' : 'origin';
  const n = words.length;
  if (n >= 2 && words[n - 2].toLowerCase() === 'from') {
    const from = words[n - 1].toLowerCase();
    if (from !== 'start' && from !== 'end' && from !== 'origin') return null;
    const pair = pairOf(words.slice(0, n - 2), ctx);
    if (!pair) return null;
    return {
      point: { at: pair.at, from },
      text: from === fallback ? pair.text : `${pair.text} from ${from}`,
    };
  }
  if (by) {
    const pair = pairOf(words, ctx);
    return pair && { point: { at: pair.at, from: 'start' }, text: pair.text };
  }
  const position = positionOf(words, ctx);
  return (
    position && {
      point: { at: position.at, from: 'origin' },
      text: position.text,
    }
  );
}

/**
 * `shape()`'s arguments: a fill rule or none, `from` and the position it
 * starts at, and one command or more, each after a comma. Null for anything
 * else — a missing comma, a trailing one, a word in the wrong place.
 */
export function parseShapeFunction(
  text: string,
  ctx: UnitContext,
): ParsedShape | null {
  const m = /^shape\(([\s\S]*)\)$/i.exec(text.trim());
  if (!m) return null;
  const parts = splitCommas(m[1]);
  if (parts.length < 2 || parts.some((p) => !p.trim())) return null;
  const first = wordsOf(parts[0]);
  let rule: ShapeFunction['rule'] = 'nonzero';
  const named = first[0]?.toLowerCase();
  if (named === 'nonzero' || named === 'evenodd') {
    rule = named;
    first.shift();
  }
  if (first[0]?.toLowerCase() !== 'from') return null;
  const from = positionOf(first.slice(1), ctx);
  if (!from) return null;
  const commands: ShapeCommand[] = [];
  const texts: string[] = [];
  for (const part of parts.slice(1)) {
    const read = commandOf(wordsOf(part), ctx);
    if (!read) return null;
    commands.push(read.command);
    texts.push(read.text);
  }
  return {
    shape: { rule, from: from.at, commands },
    text: `shape(${rule === 'evenodd' ? 'evenodd ' : ''}from ${from.text}, ${texts.join(', ')})`,
  };
}

/** A number as path data takes it, in plain digits. */
function d(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * A shape laid down in a box `w` by `h` as SVG path data, in the same
 * units the box is in. Each subpath after a `close` starts with a move to
 * where the last one started, as the shape's next command does.
 */
export function shapePathData(
  shape: ShapeFunction,
  w: number,
  h: number,
): string {
  const at = (c: Coord): [number, number] => [
    resolve(c[0], w),
    resolve(c[1], h),
  ];
  let [x, y] = at(shape.from);
  let sx = x;
  let sy = y;
  let closed = false;
  const out: string[] = [`M${d(x)} ${d(y)}`];
  for (const command of shape.commands) {
    if (command.op === 'close') {
      out.push('Z');
      [x, y] = [sx, sy];
      closed = true;
      continue;
    }
    if (closed && command.op !== 'move') out.push(`M${d(x)} ${d(y)}`);
    closed = false;
    if (command.op === 'hline' || command.op === 'vline') {
      const v = resolve(command.to, command.op === 'hline' ? w : h);
      if (command.op === 'hline') x = command.by ? x + v : v;
      else y = command.by ? y + v : v;
      out.push(`L${d(x)} ${d(y)}`);
      continue;
    }
    if (!Array.isArray(command.to)) continue;
    const [tx, ty] = at(command.to as Coord);
    const ex = command.by ? x + tx : tx;
    const ey = command.by ? y + ty : ty;
    switch (command.op) {
      case 'move':
        out.push(`M${d(ex)} ${d(ey)}`);
        [sx, sy] = [ex, ey];
        break;
      case 'line':
        out.push(`L${d(ex)} ${d(ey)}`);
        break;
      case 'curve':
      case 'smooth': {
        const points = command.with.map((c) => {
          const [cx, cy] = at(c.at);
          return c.from === 'start'
            ? [x + cx, y + cy]
            : c.from === 'end'
              ? [ex + cx, ey + cy]
              : [cx, cy];
        });
        const pts = points.map(([px, py]) => `${d(px)} ${d(py)}`).join(' ');
        const letter =
          command.op === 'curve'
            ? points.length === 2
              ? 'C'
              : 'Q'
            : points.length
              ? 'S'
              : 'T';
        out.push(`${letter}${pts ? `${pts} ` : ''}${d(ex)} ${d(ey)}`);
        break;
      }
      case 'arc': {
        const [r0, r1] = command.radii;
        let rx: number;
        let ry: number;
        if (r1 === undefined) {
          // one radius is both, and a percentage of it is of the box's
          // diagonal over √2, as a circle's is
          rx = ry = Math.abs(resolve(r0, Math.hypot(w, h) / Math.SQRT2));
        } else {
          rx = Math.abs(resolve(r0, w));
          ry = Math.abs(resolve(r1, h));
        }
        out.push(
          `A${d(rx)} ${d(ry)} ${d(command.rotate)} ${command.large ? 1 : 0} ${command.cw ? 1 : 0} ${d(ex)} ${d(ey)}`,
        );
        break;
      }
    }
    [x, y] = [ex, ey];
  }
  return out.join(' ');
}

/**
 * SVG path data read as the `shape()` it is (CSS Shapes 2, 4.3): what a
 * `path()` interpolates with a `shape()` as. Each command is the shape's —
 * an absolute one `to`, a relative one `by`, a control point from the
 * corner for an absolute curve and from the start for a relative one — its
 * numbers CSS pixels scaled to device ones. Null for data that is none.
 */
export function pathAsShape(
  d: string,
  scale: number,
  rule: ShapeFunction['rule'] = 'nonzero',
): ShapeFunction | null {
  const tokens = d.match(
    /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g,
  );
  if (!tokens || !/^[Mm]$/.test(tokens[0])) return null;
  let i = 1;
  const num = (): number => {
    const t = tokens[i];
    if (t === undefined || /[A-Za-z]/.test(t)) throw new Error('number');
    i += 1;
    return Number(t) * scale;
  };
  const flag = (): boolean => {
    const t = tokens[i];
    if (t === undefined || /[A-Za-z]/.test(t)) throw new Error('flag');
    i += 1;
    return Number(t) !== 0;
  };
  const pair = (): Coord => [num(), num()];
  try {
    const from = pair();
    const commands: ShapeCommand[] = [];
    // numbers after a move's first pair are lines, as SVG reads them
    let cmd = tokens[0] === 'm' ? 'l' : 'L';
    while (i < tokens.length) {
      if (/[A-Za-z]/.test(tokens[i])) {
        cmd = tokens[i];
        i += 1;
      }
      const by = cmd === cmd.toLowerCase();
      const control = (): ControlPoint => ({
        at: pair(),
        from: by ? 'start' : 'origin',
      });
      switch (cmd.toUpperCase()) {
        case 'M':
          commands.push({ op: 'move', by, to: pair() });
          cmd = by ? 'l' : 'L';
          break;
        case 'L':
          commands.push({ op: 'line', by, to: pair() });
          break;
        case 'H':
          commands.push({ op: 'hline', by, to: num() });
          break;
        case 'V':
          commands.push({ op: 'vline', by, to: num() });
          break;
        case 'C': {
          const first = control();
          const second = control();
          commands.push({ op: 'curve', by, with: [first, second], to: pair() });
          break;
        }
        case 'Q': {
          const only = control();
          commands.push({ op: 'curve', by, with: [only], to: pair() });
          break;
        }
        case 'S': {
          const second = control();
          commands.push({ op: 'smooth', by, with: [second], to: pair() });
          break;
        }
        case 'T':
          commands.push({ op: 'smooth', by, with: [], to: pair() });
          break;
        case 'A': {
          const rx = Math.abs(num());
          const ry = Math.abs(num());
          const rotate = num() / scale;
          const large = flag();
          const cw = flag();
          commands.push({
            op: 'arc',
            by,
            to: pair(),
            radii: [rx, ry],
            cw,
            large,
            rotate,
          });
          break;
        }
        case 'Z':
          commands.push({ op: 'close' });
          break;
        default:
          return null;
      }
    }
    return commands.length ? { rule, from, commands } : null;
  } catch {
    return null;
  }
}
