// Anchor positioning (CSS Anchor Positioning 1 and 2): an absolutely
// positioned box placed against another box, its anchor, rather than only
// against its containing block — by `anchor()` in its insets, the anchor's
// size in `anchor-size()`, or a `position-area` of the grid the anchor makes
// of its containing block — and, where it overflows that containing block,
// placed again by each of its `position-try-fallbacks` until one fits,
// which an anchored container query asks after (`anchored(fallback: …)`).
//
// What is here is the values as the cascade reads them and the arithmetic
// of one placement, with no tree: finding the anchor and laying the box out
// are layout's (`layoutPositioned`, `layout/block.ts`).

import { AUTO, parseLength, splitCommas, splitValue } from './values.js';
import type { Len, UnitContext } from './values.js';

/** Which edge of the anchor, or how far across it, an `anchor()` reads:
 *  a physical side, a logical one or `center`, `inside` and `outside` —
 *  the inset's own side and the side opposite — or a fraction from the
 *  start (`<percentage>`). */
export type AnchorSide =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'center'
  | 'start'
  | 'end'
  | 'self-start'
  | 'self-end'
  | 'inside'
  | 'outside'
  | number;

const SIDES = new Set<string>([
  'top',
  'right',
  'bottom',
  'left',
  'center',
  'start',
  'end',
  'self-start',
  'self-end',
  'inside',
  'outside',
]);

/** An `anchor()` an inset is: the anchor it names, null for the box's
 *  default (`position-anchor`), the side it reads, and what the inset is
 *  where there is no such anchor. */
export interface AnchorRef {
  name: string | null;
  side: AnchorSide;
  fallback: Len | null;
}

/** An `anchor-size()` a size is: of the named anchor or the default, the
 *  anchor's width or height, and the fallback. */
export interface AnchorSizeRef {
  name: string | null;
  size: 'width' | 'height';
  fallback: Len | null;
}

export type InsetSide = 'top' | 'right' | 'bottom' | 'left';

/** The function and its arguments where `value` is one call of `fn`
 *  alone; null otherwise. */
function callOf(value: string, fn: string): string[] | null {
  const m = new RegExp(`^${fn}\\(([\\s\\S]*)\\)$`, 'i').exec(value.trim());
  if (!m) return null;
  return splitCommas(m[1]).map((a) => a.trim());
}

/** Whether a value holds an `anchor()` or an `anchor-size()`. */
export function readsAnchor(value: string): boolean {
  return /\banchor(-size)?\(/i.test(value);
}

/**
 * `anchor( <anchor-name>? && <anchor-side>, <length-percentage>? )`, the
 * whole of an inset's value; null for anything else, which drops the
 * declaration — an `anchor()` inside a `calc()` among them.
 */
export function parseAnchor(value: string, ctx: UnitContext): AnchorRef | null {
  const args = callOf(value, 'anchor');
  if (!args || !args.length || args.length > 2) return null;
  let name: string | null = null;
  let side: AnchorSide | null = null;
  for (const part of splitValue(args[0])) {
    const lower = part.toLowerCase();
    if (part.startsWith('--') && name === null) name = part;
    else if (SIDES.has(lower) && side === null) side = lower as AnchorSide;
    else if (/%$/.test(part) && side === null) {
      const n = Number(part.slice(0, -1));
      if (!Number.isFinite(n)) return null;
      side = n / 100;
    } else return null;
  }
  if (side === null) return null;
  let fallback: Len | null = null;
  if (args[1] !== undefined) {
    const len = parseLength(args[1], ctx);
    if (len === null || len === AUTO) return null;
    fallback = len;
  }
  return { name, side, fallback };
}

/** `anchor-size( <anchor-name>? && <anchor-size>?, <length-percentage>? )`
 *  for a width or a height: the anchor's size along the property's own
 *  axis where it names none. Null for anything else. */
export function parseAnchorSize(
  value: string,
  property: 'width' | 'height',
  ctx: UnitContext,
): AnchorSizeRef | null {
  const args = callOf(value, 'anchor-size');
  if (!args || args.length > 2) return null;
  let name: string | null = null;
  let size: 'width' | 'height' | null = null;
  for (const part of args[0] ? splitValue(args[0]) : []) {
    const lower = part.toLowerCase();
    if (part.startsWith('--') && name === null) name = part;
    else if (size === null && (lower === 'width' || lower === 'inline')) {
      size = 'width';
    } else if (size === null && (lower === 'height' || lower === 'block')) {
      size = 'height';
    } else if (size === null && lower === 'self-inline') size = 'width';
    else if (size === null && lower === 'self-block') size = 'height';
    else return null;
  }
  let fallback: Len | null = null;
  if (args[1] !== undefined) {
    const len = parseLength(args[1], ctx);
    if (len === null || len === AUTO) return null;
    fallback = len;
  }
  return { name, size: size ?? property, fallback };
}

/**
 * A `position-area`: the tracks of the 3×3 grid the anchor makes of the
 * containing block it takes, across (`cols`) and down (`rows`), each a
 * first and a last track — 0 before the anchor, 1 the anchor's, 2 after —
 * and whether the tracks across are logical, which a right-to-left box
 * reads from its right.
 */
export interface PositionArea {
  cols: readonly [number, number];
  rows: readonly [number, number];
  logicalCols: boolean;
  /** Its keywords in canonical order (`positionAreaText`), which is its
   *  computed value. */
  text?: string;
}

type Track = {
  axis: 'x' | 'y' | 'any';
  tracks: [number, number];
  logical: boolean;
};

/** The tracks a `position-area` keyword takes, and the axis it is of. */
function trackOf(word: string): Track | null {
  const range = (w: string): [number, number] | null =>
    w === 'start'
      ? [0, 0]
      : w === 'end'
        ? [2, 2]
        : w === 'span-start'
          ? [0, 1]
          : w === 'span-end'
            ? [1, 2]
            : null;
  switch (word) {
    case 'left':
      return { axis: 'x', tracks: [0, 0], logical: false };
    case 'right':
      return { axis: 'x', tracks: [2, 2], logical: false };
    case 'span-left':
      return { axis: 'x', tracks: [0, 1], logical: false };
    case 'span-right':
      return { axis: 'x', tracks: [1, 2], logical: false };
    case 'top':
      return { axis: 'y', tracks: [0, 0], logical: false };
    case 'bottom':
      return { axis: 'y', tracks: [2, 2], logical: false };
    case 'span-top':
      return { axis: 'y', tracks: [0, 1], logical: false };
    case 'span-bottom':
      return { axis: 'y', tracks: [1, 2], logical: false };
    case 'center':
      return { axis: 'any', tracks: [1, 1], logical: false };
    case 'span-all':
      return { axis: 'any', tracks: [0, 2], logical: false };
  }
  // the logical ones: `block-…` and `y-…` down, `inline-…` and `x-…`
  // across, `self-` as the box's own, which here is the containing block's
  const m =
    /^(span-)?(?:self-)?(block|inline|x|y)-(start|end)$/.exec(word) ??
    /^(span-)?(?:self-)?(start|end)$/.exec(word);
  if (!m) return null;
  const [, span, axisOrEdge, edge] = m;
  const across = axisOrEdge === 'inline' || axisOrEdge === 'x';
  const down = axisOrEdge === 'block' || axisOrEdge === 'y';
  const tracks = range(`${span ?? ''}${edge ?? axisOrEdge}`);
  if (!tracks) return null;
  return {
    axis: across ? 'x' : down ? 'y' : 'any',
    tracks,
    logical: across || (!across && !down),
  };
}

/** `none`, or a `position-area`'s one or two keywords; undefined for
 *  anything else. One keyword of one axis takes all of the other's tracks,
 *  and one of either axis is both. */
export function parsePositionArea(
  value: string,
): PositionArea | null | undefined {
  const text = positionAreaText(value);
  if (text === null) return undefined;
  const words = splitValue(value.trim().toLowerCase());
  if (words.length === 1 && words[0] === 'none') return null;
  if (!words.length || words.length > 2) return undefined;
  const read = words.map(trackOf);
  if (read.some((t) => t === null)) return undefined;
  const [a, b] = read as Track[];
  let x: Track | undefined;
  let y: Track | undefined;
  if (!b) {
    if (a.axis === 'x') x = a;
    else if (a.axis === 'y') y = a;
    else x = y = a;
  } else if (a.axis === 'x' || b.axis === 'y') {
    if (a.axis === 'y' || b.axis === 'x') return undefined;
    x = a;
    y = b;
  } else if (a.axis === 'y' || b.axis === 'x') {
    x = b;
    y = a;
  } else {
    // two that are either: the block axis first, as `start end` is
    y = a;
    x = b;
  }
  const all: Track = { axis: 'any', tracks: [0, 2], logical: false };
  x ??= all;
  y ??= all;
  return { cols: x.tracks, rows: y.tracks, logicalCols: x.logical, text };
}

const AREA_GROUPS: [string, readonly string[]][] = [
  [
    'x',
    [
      'left',
      'right',
      'span-left',
      'span-right',
      'x-start',
      'x-end',
      'span-x-start',
      'span-x-end',
      'self-x-start',
      'self-x-end',
      'span-self-x-start',
      'span-self-x-end',
    ],
  ],
  [
    'y',
    [
      'top',
      'bottom',
      'span-top',
      'span-bottom',
      'y-start',
      'y-end',
      'span-y-start',
      'span-y-end',
      'self-y-start',
      'self-y-end',
      'span-self-y-start',
      'span-self-y-end',
    ],
  ],
  ['block', ['block-start', 'block-end', 'span-block-start', 'span-block-end']],
  [
    'inline',
    ['inline-start', 'inline-end', 'span-inline-start', 'span-inline-end'],
  ],
  [
    'self-block',
    [
      'self-block-start',
      'self-block-end',
      'span-self-block-start',
      'span-self-block-end',
    ],
  ],
  [
    'self-inline',
    [
      'self-inline-start',
      'self-inline-end',
      'span-self-inline-start',
      'span-self-inline-end',
    ],
  ],
  ['start-end', ['start', 'end', 'span-start', 'span-end']],
  [
    'self-start-end',
    ['self-start', 'self-end', 'span-self-start', 'span-self-end'],
  ],
];
const AREA_GROUP = new Map<string, string>();
for (const [group, words] of AREA_GROUPS) {
  for (const w of words) AREA_GROUP.set(w, group);
}
/** The groups of an axis that come first and second in a pair. */
const FIRST_AXIS = new Set(['x', 'block', 'self-block']);
const PAIRED: Record<string, string> = {
  x: 'y',
  y: 'x',
  block: 'inline',
  inline: 'block',
  'self-block': 'self-inline',
  'self-inline': 'self-block',
};

/**
 * A `position-area` value in canonical form (CSS Anchor Positioning 1,
 * 3.1), or null where it is none: one keyword, or two of axes that pair —
 * the horizontal or block one first — `center` and `span-all` taking
 * either axis, a repeated keyword once, and `span-all` beside one of an
 * axis left out, since one keyword alone spans the other.
 */
export function positionAreaText(value: string): string | null {
  const words = splitValue(value.trim().toLowerCase());
  if (words.length === 1) {
    const [w] = words;
    return w === 'none' ||
      w === 'center' ||
      w === 'span-all' ||
      AREA_GROUP.has(w)
      ? w
      : null;
  }
  if (words.length !== 2) return null;
  const [a, b] = words;
  const generic = (w: string) => w === 'center' || w === 'span-all';
  const ga = AREA_GROUP.get(a);
  const gb = AREA_GROUP.get(b);
  if ((!ga && !generic(a)) || (!gb && !generic(b))) return null;
  if (a === b) {
    return generic(a) || ga === 'start-end' || ga === 'self-start-end'
      ? a
      : null;
  }
  if (generic(a) && generic(b)) return `${a} ${b}`;
  // `start` and `end` say no axis: the first is the block one
  const either = (g: string | undefined) =>
    g === 'start-end' || g === 'self-start-end';
  if (either(ga) || either(gb)) {
    if (generic(a) || generic(b) || ga === gb) return `${a} ${b}`;
    return null;
  }
  if (generic(a) || generic(b)) {
    const word = generic(a) ? b : a;
    const other = generic(a) ? a : b;
    if (other === 'span-all') return word;
    return FIRST_AXIS.has(AREA_GROUP.get(word)!)
      ? `${word} center`
      : `center ${word}`;
  }
  if (PAIRED[ga!] !== gb) return null;
  return FIRST_AXIS.has(ga!) ? `${a} ${b}` : `${b} ${a}`;
}

/** A `position-area`'s tracks across as the physical ones, for a box
 *  whose direction is right to left where `rtl`. */
export function physicalCols(
  area: PositionArea,
  rtl: boolean,
): [number, number] {
  const [a, b] = area.cols;
  return area.logicalCols && rtl ? [2 - b, 2 - a] : [a, b];
}

/** How far along its free room a box is aligned in its `position-area` on
 *  an axis whose tracks are `[a, b]`, as `normal` has it (CSS Anchor
 *  Positioning 1, 3.1.4): towards the anchor — at the end of the tracks
 *  before it, the start of those after it, and centred where it has the
 *  anchor's track alone or all three. */
export function areaAlignment(tracks: readonly [number, number]): number {
  const [a, b] = tracks;
  if (a === b) return a === 0 ? 1 : a === 2 ? 0 : 0.5;
  if (a === 0 && b === 2) return 0.5;
  return a === 0 ? 1 : 0;
}

/** Where along an axis each of a `position-area`'s four grid lines is: the
 *  containing block's start, the anchor's two edges and the containing
 *  block's end, each held inside the containing block. */
export function areaLines(
  cbStart: number,
  cbSize: number,
  anchorStart: number,
  anchorSize: number,
): [number, number, number, number] {
  const end = cbStart + cbSize;
  const clamp = (v: number) => Math.min(end, Math.max(cbStart, v));
  return [cbStart, clamp(anchorStart), clamp(anchorStart + anchorSize), end];
}

/**
 * An inset an `anchor()` comes to, for an anchor across or down from
 * `anchorStart` for `anchorSize`, against a containing block from `cbStart`
 * for `cbSize`: the distance from the containing block's edge on the
 * inset's side to the anchor's edge the function reads. `inside` is the
 * inset's own side and `outside` the other; `start` and `end` the
 * containing block's, read right to left where `rtl` across.
 */
export function anchorInset(
  inset: InsetSide,
  side: AnchorSide,
  anchorStart: number,
  anchorSize: number,
  cbStart: number,
  cbSize: number,
  rtl: boolean,
): number {
  const across = inset === 'left' || inset === 'right';
  const atStart = inset === 'top' || inset === 'left';
  // the fraction from the anchor's top or left
  let f: number;
  if (typeof side === 'number') f = across && rtl ? 1 - side : side;
  else {
    switch (side) {
      case 'top':
      case 'left':
        f = 0;
        break;
      case 'bottom':
      case 'right':
        f = 1;
        break;
      case 'center':
        f = 0.5;
        break;
      case 'inside':
        f = atStart ? 0 : 1;
        break;
      case 'outside':
        f = atStart ? 1 : 0;
        break;
      case 'start':
      case 'self-start':
        f = across && rtl ? 1 : 0;
        break;
      default:
        f = across && rtl ? 0 : 1;
    }
  }
  const at = anchorStart + f * anchorSize;
  return atStart ? at - cbStart : cbStart + cbSize - at;
}

/** A way a position is tried again (`<try-tactic>`): mirrored down, across,
 *  or about the diagonal from its start; `flip-y` and `flip-x` are the
 *  physical names of the first two, which in the one horizontal writing
 *  mode here are the same. */
export type TryTactic =
  'flip-block' | 'flip-inline' | 'flip-start' | 'flip-x' | 'flip-y';

/**
 * One option of `position-try-fallbacks`: a `@position-try` rule's name,
 * the tactics applied after it, or a `position-area` that replaces the
 * box's. `text` is the option as written, a space between its words, which
 * an anchored container query matches.
 */
export interface TryOption {
  name: string | null;
  tactics: readonly TryTactic[];
  area: PositionArea | null;
  text: string;
}

const TACTICS = new Set<string>([
  'flip-block',
  'flip-inline',
  'flip-start',
  'flip-x',
  'flip-y',
]);

/** One option, or null where it is none. */
function parseTryOption(item: string): TryOption | null {
  const words = splitValue(item.trim());
  if (!words.length) return null;
  const lower = words.map((w) => w.toLowerCase());
  let name: string | null = null;
  const tactics: TryTactic[] = [];
  let tacticsDone = false;
  for (let i = 0; i < words.length; i += 1) {
    const w = lower[i];
    if (words[i].startsWith('--') && name === null) {
      // a name before the tactics, or after them
      if (tactics.length) tacticsDone = true;
      name = words[i];
    } else if (
      TACTICS.has(w) &&
      !tacticsDone &&
      !tactics.includes(w as TryTactic)
    ) {
      tactics.push(w as TryTactic);
    } else {
      // a `position-area` alone
      if (name !== null || tactics.length) return null;
      const area = parsePositionArea(item);
      if (!area) return null;
      return { name: null, tactics: [], area, text: lower.join(' ') };
    }
  }
  return { name, tactics, area: null, text: lower.join(' ') };
}

/** `position-try-fallbacks`, or the fallbacks of `position-try`: `none`,
 *  or a list of options; undefined for anything else. */
export function parseTryFallbacks(
  value: string,
): TryOption[] | null | undefined {
  if (/^\s*none\s*$/i.test(value)) return null;
  const out: TryOption[] = [];
  for (const item of splitCommas(value)) {
    const option = parseTryOption(item);
    if (!option) return undefined;
    out.push(option);
  }
  return out;
}

/**
 * An anchored container query's `fallback` feature, for an anchored
 * container that applied `applied` — an option's text, or null for none
 * (CSS Anchor Positioning 2): with no value, whether one applied; `none`,
 * whether none did; and an option, whether it is the one, a
 * `position-area` matched by the tracks it takes.
 */
export function fallbackMatches(
  value: string | undefined,
  applied: string | null,
): boolean | null {
  if (value === undefined) return applied !== null;
  const v = splitValue(value.trim().toLowerCase()).join(' ');
  if (v === 'none') return applied === null;
  const query = parseTryOption(v);
  if (!query) return null;
  if (applied === null) return false;
  if (query.area) {
    const was = parsePositionArea(applied);
    return (
      !!was &&
      was.cols[0] === query.area.cols[0] &&
      was.cols[1] === query.area.cols[1] &&
      was.rows[0] === query.area.rows[0] &&
      was.rows[1] === query.area.rows[1]
    );
  }
  return v === applied;
}

/**
 * A `position-area` as it computes, from its canonical text: a pair of a
 * block and an inline keyword — `self-` ones too — said with `start` and
 * `end`, which name the block axis first, and once where the two are the
 * same (CSS Anchor Positioning 1, 3.1).
 */
export function positionAreaComputed(text: string): string {
  const words = text.split(' ');
  if (words.length !== 2) return text;
  // `start` or `end` with `span-all` is one axis's keyword alone: the
  // first place is the block axis's
  const either = /^(span-)?(self-)?(start|end)$/;
  if (words.includes('span-all')) {
    const other = words[0] === 'span-all' ? words[1] : words[0];
    const m = either.exec(other);
    if (m && other !== 'span-all') {
      const axis = words[0] === 'span-all' ? 'inline' : 'block';
      return `${m[1] ?? ''}${m[2] ?? ''}${axis}-${m[3]}`;
    }
  }
  const logical = /^(span-)?(self-)?(block|inline)-(start|end)$/;
  if (!words.some((w) => logical.test(w))) return text;
  if (
    !words.every((w) => logical.test(w) || w === 'center' || w === 'span-all')
  ) {
    return text;
  }
  const mapped = words.map((w) =>
    w.replace(
      logical,
      (_m, span, self, _axis, edge) => `${span ?? ''}${self ?? ''}${edge}`,
    ),
  );
  return mapped[0] === mapped[1] ? mapped[0] : mapped.join(' ');
}
