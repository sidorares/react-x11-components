// `animation` and its longhands (CSS Animations 1, 4), read into the lists
// an element's animations are, and what those animations leave on its
// style.
//
// Nothing here runs an animation: a document is drawn as it stands once
// each of its animations has run one iteration at no length. One that
// fills forwards then holds the frame it ended on, and any other leaves
// the style it started from. That is the moment the Zen Garden bench holds
// Chrome at (`scripts/zengarden/chrome.ts`), and the one a page that fades
// its panels in and holds them is meant to be seen at: drawn as it starts,
// a panel that animates in from nothing is never there. So the cascade asks
// `restingFrames` for the declarations of each such frame and applies them
// above the author's own, as the animation origin is (CSS Cascade 5, 6.1).

import { parseMath } from './calc.js';
import type { Declaration, KeyframesRule } from './parse.js';
import { parseNumber, splitCommas, splitValue } from './values.js';

/**
 * An easing function (CSS Easing 2), as an animation's timing function or
 * a keyframe's: the identity, a cubic Bézier, steps, or the points of a
 * `linear()` with every input placed.
 */
export type Easing =
  | { type: 'linear' }
  | { type: 'cubic'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'steps'; count: number; position: StepPosition }
  | { type: 'points'; points: readonly { input: number; output: number }[] };

export type StepPosition =
  'jump-start' | 'jump-end' | 'jump-none' | 'jump-both';

export type AnimationDirection =
  'normal' | 'reverse' | 'alternate' | 'alternate-reverse';

export type FillMode = 'none' | 'forwards' | 'backwards' | 'both';

export type PlayState = 'running' | 'paused';

/**
 * An element's animations: each longhand's list as computed. There are as
 * many animations as `names` has entries; a shorter list of another
 * longhand repeats, and a longer one is cut (CSS Animations 1, 4).
 */
export interface Animations {
  /** `animation-name`: the `@keyframes` each runs, null for `none`. */
  readonly names: readonly (string | null)[];
  /** `animation-duration`, in milliseconds: `auto` is 0. */
  readonly durations: readonly number[];
  /** `animation-timing-function`. */
  readonly easings: readonly Easing[];
  /** `animation-delay`, in milliseconds, before the first iteration. */
  readonly delays: readonly number[];
  /** `animation-iteration-count`: `infinite` is `Infinity`. */
  readonly iterations: readonly number[];
  readonly directions: readonly AnimationDirection[];
  readonly fillModes: readonly FillMode[];
  readonly playStates: readonly PlayState[];
}

const LINEAR: Easing = { type: 'linear' };
const EASE: Easing = { type: 'cubic', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };

/** The easing keywords (CSS Easing 2, 2.2 and 3.1). */
const EASINGS: Record<string, Easing> = {
  linear: LINEAR,
  ease: EASE,
  'ease-in': { type: 'cubic', x1: 0.42, y1: 0, x2: 1, y2: 1 },
  'ease-out': { type: 'cubic', x1: 0, y1: 0, x2: 0.58, y2: 1 },
  'ease-in-out': { type: 'cubic', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  'step-start': { type: 'steps', count: 1, position: 'jump-start' },
  'step-end': { type: 'steps', count: 1, position: 'jump-end' },
};

/** The initial value of every longhand: one animation, of nothing. Every
 *  element without one shares it, which is how the cascade tells. */
export const NO_ANIMATIONS: Animations = {
  names: [null],
  durations: [0],
  easings: [EASE],
  delays: [0],
  iterations: [1],
  directions: ['normal'],
  fillModes: ['none'],
  playStates: ['running'],
};

/** The longhands, by property name, and the list each is. */
export const ANIMATION_LONGHANDS: Record<string, keyof Animations> = {
  'animation-name': 'names',
  'animation-duration': 'durations',
  'animation-timing-function': 'easings',
  'animation-delay': 'delays',
  'animation-iteration-count': 'iterations',
  'animation-direction': 'directions',
  'animation-fill-mode': 'fillModes',
  'animation-play-state': 'playStates',
};

const DIRECTIONS = new Set<string>([
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
]);
const FILL_MODES = new Set<string>(['none', 'forwards', 'backwards', 'both']);
const PLAY_STATES = new Set<string>(['running', 'paused']);

/** One value of each longhand's list; undefined where it is none, and so
 *  is null but for a name, where it is `none`. */
const ONE: {
  [K in keyof Animations]: (
    value: string,
  ) => Animations[K][number] | null | undefined;
} = {
  names: animationName,
  durations: (v) => (v.toLowerCase() === 'auto' ? 0 : duration(v)),
  easings: parseEasing,
  delays: parseTime,
  iterations: iterationCount,
  directions: (v) => keyword(v, DIRECTIONS) as AnimationDirection | null,
  fillModes: (v) => keyword(v, FILL_MODES) as FillMode | null,
  playStates: (v) => keyword(v, PLAY_STATES) as PlayState | null,
};

/**
 * `animations` with one longhand's list set from a declaration's value, or
 * null where the value is not a list of that longhand's values and the
 * declaration is dropped.
 */
export function animationLonghand(
  animations: Animations,
  key: keyof Animations,
  value: string,
): Animations | null {
  const read = ONE[key] as (value: string) => unknown;
  const list: unknown[] = [];
  for (const item of splitCommas(value)) {
    const one = read(item.trim());
    if (one === undefined || (one === null && key !== 'names')) return null;
    list.push(one);
  }
  return { ...animations, [key]: list };
}

/**
 * The `animation` shorthand: a comma list of animations, each its
 * longhands' values in any order and the rest at their initial values — or
 * null where an item is not one. The first time is the duration and the
 * second the delay; a keyword goes to the first longhand it is a value of
 * that the item has not set, and only then is it the name, so that
 * `animation: none` is a fill mode and `animation: 1s forwards slide` names
 * `slide` (CSS Animations 1, 4.9).
 */
export function parseAnimation(value: string): Animations | null {
  const names: (string | null)[] = [];
  const durations: number[] = [];
  const easings: Easing[] = [];
  const delays: number[] = [];
  const iterations: number[] = [];
  const directions: AnimationDirection[] = [];
  const fillModes: FillMode[] = [];
  const playStates: PlayState[] = [];
  for (const item of splitCommas(value)) {
    const tokens = splitValue(item.trim());
    if (!tokens.length) return null;
    let name: string | null | undefined;
    let time = 0;
    let dur: number | undefined;
    let del: number | undefined;
    let easing: Easing | undefined;
    let count: number | undefined;
    let direction: AnimationDirection | undefined;
    let fill: FillMode | undefined;
    let play: PlayState | undefined;
    for (const token of tokens) {
      const lower = token.toLowerCase();
      const t = parseTime(token);
      if (t !== null) {
        if (time === 0) {
          if (t < 0) return null;
          dur = t;
        } else if (time === 1) {
          del = t;
        } else {
          return null;
        }
        time += 1;
        continue;
      }
      if (easing === undefined) {
        const e = parseEasing(token);
        if (e !== null) {
          easing = e;
          continue;
        }
      }
      if (count === undefined) {
        const n = iterationCount(token);
        if (n !== null) {
          count = n;
          continue;
        }
      }
      if (direction === undefined && DIRECTIONS.has(lower)) {
        direction = lower as AnimationDirection;
      } else if (fill === undefined && FILL_MODES.has(lower)) {
        fill = lower as FillMode;
      } else if (play === undefined && PLAY_STATES.has(lower)) {
        play = lower as PlayState;
      } else if (name === undefined) {
        const n = animationName(token);
        if (n === undefined) return null;
        name = n;
      } else {
        return null;
      }
    }
    names.push(name ?? null);
    durations.push(dur ?? 0);
    easings.push(easing ?? EASE);
    delays.push(del ?? 0);
    iterations.push(count ?? 1);
    directions.push(direction ?? 'normal');
    fillModes.push(fill ?? 'none');
    playStates.push(play ?? 'running');
  }
  return {
    names,
    durations,
    easings,
    delays,
    iterations,
    directions,
    fillModes,
    playStates,
  };
}

/** An `animation-name` entry: the name, null for `none`, and undefined for
 *  what is neither — a CSS-wide keyword, `default`, or no identifier. */
function animationName(value: string): string | null | undefined {
  const v = value.trim();
  if (v[0] === '"' || v[0] === "'") {
    const q = v[0];
    return v.length >= 2 && v[v.length - 1] === q ? v.slice(1, -1) : undefined;
  }
  const lower = v.toLowerCase();
  if (lower === 'none') return null;
  if (!IDENT.test(v) || RESERVED.has(lower)) return undefined;
  return v;
}

const IDENT = /^-?(?:[_a-zA-Z\u0080-￿]|--)[\w\u0080-￿-]*$/;

const RESERVED = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'default',
]);

/** A `<time>` in milliseconds: `2s`, `150ms`, a `calc()` of them; null
 *  for anything else. */
export function parseTime(value: string): number | null {
  const v = value.trim().toLowerCase();
  const m = TIME.exec(v);
  if (m) return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
  if (!v.includes('(')) return null;
  const sum = parseMath(v, (token) => {
    const unit = TIME.exec(token);
    return unit ? Number(unit[1]) * (unit[2] === 's' ? 1000 : 1) : null;
  });
  return typeof sum === 'number' ? sum : null;
}

const TIME = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(s|ms)$/;

/** A duration: a time that is not negative. */
function duration(value: string): number | null {
  const t = parseTime(value);
  return t !== null && t >= 0 ? t : null;
}

/** `infinite`, or a number that is not negative. */
function iterationCount(value: string): number | null {
  const v = value.trim().toLowerCase();
  if (v === 'infinite') return Infinity;
  const n = parseNumber(v);
  return n !== null && n >= 0 ? n : null;
}

function keyword(value: string, set: ReadonlySet<string>): string | null {
  const v = value.trim().toLowerCase();
  return set.has(v) ? v : null;
}

/**
 * An easing function (CSS Easing 2): a keyword, `cubic-bezier()`,
 * `steps()` or `linear()`; null for anything else.
 */
export function parseEasing(value: string): Easing | null {
  const v = value.trim().toLowerCase();
  const named = EASINGS[v];
  if (named) return named;
  const m = /^(cubic-bezier|steps|linear)\((.*)\)$/s.exec(v);
  if (!m) return null;
  const args = splitCommas(m[2]);
  if (m[1] === 'cubic-bezier') {
    if (args.length !== 4) return null;
    const [x1, y1, x2, y2] = args.map(parseNumber);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    // the x of each control point is a time, inside the interval
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
    return { type: 'cubic', x1, y1, x2, y2 };
  }
  if (m[1] === 'steps') {
    if (args.length < 1 || args.length > 2) return null;
    const count = parseNumber(args[0]);
    if (count === null || !Number.isInteger(count)) return null;
    const position = stepPosition(args[1]);
    if (!position) return null;
    if (count < (position === 'jump-none' ? 2 : 1)) return null;
    return { type: 'steps', count, position };
  }
  return linearPoints(args);
}

function stepPosition(value: string | undefined): StepPosition | null {
  const v = value?.trim() ?? 'jump-end';
  if (v === 'start') return 'jump-start';
  if (v === 'end') return 'jump-end';
  return v === 'jump-start' ||
    v === 'jump-end' ||
    v === 'jump-none' ||
    v === 'jump-both'
    ? v
    : null;
}

/**
 * `linear()`'s stops as points (CSS Easing 2, 2.1.1): each an output with
 * up to two input percentages, two making two points. The first point
 * with no input is at 0 and the last at 1, an input less than one before
 * it is that one, and the points between two that have one are spread
 * evenly between them.
 */
function linearPoints(args: string[]): Easing | null {
  const points: { input: number | null; output: number }[] = [];
  for (const arg of args) {
    const parts = splitValue(arg.trim());
    let output: number | null = null;
    const inputs: number[] = [];
    for (const part of parts) {
      if (part.endsWith('%')) {
        const pct = parseNumber(part.slice(0, -1));
        if (pct === null || inputs.length === 2) return null;
        inputs.push(pct / 100);
      } else {
        if (output !== null) return null;
        output = parseNumber(part);
        if (output === null) return null;
      }
    }
    if (output === null) return null;
    if (!inputs.length) points.push({ input: null, output });
    for (const input of inputs) points.push({ input, output });
  }
  if (points.length < 2) return null;
  if (points[0].input === null) points[0].input = 0;
  const last = points[points.length - 1];
  if (last.input === null) last.input = Math.max(1, highest(points));
  let largest = -Infinity;
  for (const point of points) {
    if (point.input === null) continue;
    if (point.input < largest) point.input = largest;
    largest = point.input;
  }
  for (let i = 1; i < points.length;) {
    if (points[i].input !== null) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (points[j].input === null) j += 1;
    const from = points[i - 1].input!;
    const to = points[j].input!;
    for (let k = i; k < j; k += 1) {
      points[k].input = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    }
    i = j + 1;
  }
  return {
    type: 'points',
    points: points as { input: number; output: number }[],
  };
}

/** The largest input placed so far. */
function highest(points: { input: number | null }[]): number {
  let out = -Infinity;
  for (const point of points) {
    if (point.input !== null && point.input > out) out = point.input;
  }
  return out;
}

/**
 * The declarations an element's animations leave on its style once each
 * has run one iteration at no length, one list an animation, in the order
 * they are named — a later one over an earlier where both set a property
 * (CSS Animations 1, 4.2). An animation leaves the frame it ends on where
 * it fills forwards: the `to` frame, or the `from` frame where it plays in
 * reverse, merged where several frames are at that offset, a later one's
 * declaration over an earlier one's. A property the frame does not set is
 * the element's own, which there is nothing to say about. Null where no
 * animation leaves anything.
 */
export function restingFrames(
  animations: Animations,
  keyframesOf: (name: string) => KeyframesRule | null,
): Declaration[][] | null {
  let out: Declaration[][] | null = null;
  const { names, directions, fillModes } = animations;
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (name === null) continue;
    const fill = fillModes[i % fillModes.length];
    if (fill !== 'forwards' && fill !== 'both') continue;
    const rule = keyframesOf(name);
    if (!rule) continue;
    const direction = directions[i % directions.length];
    const reversed =
      direction === 'reverse' || direction === 'alternate-reverse';
    const frame = endFrame(rule, reversed ? 0 : 1);
    if (frame.length) (out ??= []).push(frame);
  }
  return out;
}

/** The declarations at one offset of a `@keyframes`, in the order written:
 *  one array per rule and offset, so the cascade sees the same one each
 *  time it asks. */
function endFrame(rule: KeyframesRule, offset: 0 | 1): Declaration[] {
  let ends = END_FRAMES.get(rule);
  if (!ends) {
    ends = [null, null];
    END_FRAMES.set(rule, ends);
  }
  let frame = ends[offset];
  if (!frame) {
    frame = [];
    for (const f of rule.frames) {
      if (f.offsets.includes(offset)) frame.push(...f.declarations);
    }
    ends[offset] = frame;
  }
  return frame;
}

const END_FRAMES = new WeakMap<
  KeyframesRule,
  [Declaration[] | null, Declaration[] | null]
>();
