// `animation` and its longhands (CSS Animations 1, 4), read into the lists
// an element's animations are; how far through its frames an animation is
// at a time (Web Animations 1, 4); and what an animation leaves on a style
// where none runs.
//
// An animation runs on the document's timeline (`css/timeline.ts`), which
// the cascade asks for each animated element's progress through each of
// its animations as it styles it, and interpolates between the frames
// around it (`Cascade._computeStyle`, `css/interpolate.ts`). An
// application can have none run (`<Html animate={false}>`): a document is
// then drawn as it stands once each animation has run one iteration at no
// length. One that fills forwards holds the frame it ended on, and any
// other leaves the style it started from. That is the moment the Zen
// Garden bench holds Chrome at (`scripts/zengarden/chrome.ts`), and the one
// a page that fades its panels in and holds them is meant to be seen at:
// drawn as it starts, a panel that animates in from nothing is never
// there. So the cascade asks `restingFrames` for the declarations of each
// such frame and applies them above the author's own, as the animation
// origin is (CSS Cascade 5, 6.1).

import { parseMath } from './calc.js';
import type { Declaration, Keyframe, KeyframesRule } from './parse.js';
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

/** `transition-behavior` (CSS Transitions 2, 2.1): whether a property whose
 *  values go over discretely transitions at all. */
export type TransitionBehavior = 'normal' | 'allow-discrete';

/**
 * `transition` and its longhands (CSS Transitions 1, 2), a list each, as an
 * animation's are, and the list a property's transition takes its
 * duration, timing function, delay and behavior from at the index its name
 * is at in `properties` (`transitionFields`, `css/timeline.ts`).
 */
export interface Transitions {
  /** `transition-property`: the property each is of — its name, or `all`
   *  for every one — and none at all for `none`. */
  readonly properties: readonly string[];
  /** `transition-duration`, in milliseconds. */
  readonly durations: readonly number[];
  /** `transition-timing-function`. */
  readonly easings: readonly Easing[];
  /** `transition-delay`, in milliseconds: one that is negative starts that
   *  far in. */
  readonly delays: readonly number[];
  readonly behaviors: readonly TransitionBehavior[];
}

/** The initial value of every longhand: every property, in no time — which
 *  is no transition at all. */
export const NO_TRANSITIONS: Transitions = {
  properties: ['all'],
  durations: [0],
  easings: [EASE],
  delays: [0],
  behaviors: ['normal'],
};

/** The longhands, by property name, and the list each is. */
export const TRANSITION_LONGHANDS: Record<string, keyof Transitions> = {
  'transition-property': 'properties',
  'transition-duration': 'durations',
  'transition-timing-function': 'easings',
  'transition-delay': 'delays',
  'transition-behavior': 'behaviors',
};

const BEHAVIORS = new Set<string>(['normal', 'allow-discrete']);

/** A `transition-property` entry: `all`, or a property's name, lowercased;
 *  undefined for what is neither — `none`, a CSS-wide keyword, or no
 *  identifier. */
function transitionProperty(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'none' || !IDENT.test(v) || RESERVED.has(v)) return undefined;
  return v;
}

/** One value of each longhand's list; null where it is none. */
const ONE_TRANSITION: {
  [K in keyof Transitions]: (value: string) => Transitions[K][number] | null;
} = {
  properties: (v) => transitionProperty(v) ?? null,
  durations: duration,
  easings: parseEasing,
  delays: parseTime,
  behaviors: (v) => keyword(v, BEHAVIORS) as TransitionBehavior | null,
};

/**
 * `transitions` with one longhand's list set from a declaration's value, or
 * null where the value is not a list of that longhand's values and the
 * declaration is dropped. `transition-property: none` is no property at
 * all, and `none` among others is no value.
 */
export function transitionLonghand(
  transitions: Transitions,
  key: keyof Transitions,
  value: string,
): Transitions | null {
  if (key === 'properties' && value.trim().toLowerCase() === 'none') {
    return { ...transitions, properties: [] };
  }
  const read = ONE_TRANSITION[key] as (value: string) => unknown;
  const list: unknown[] = [];
  for (const item of splitCommas(value)) {
    const one = read(item.trim());
    if (one === null) return null;
    list.push(one);
  }
  return { ...transitions, [key]: list };
}

/**
 * The `transition` shorthand: a comma list of transitions, each a property
 * or `none`, a duration, a timing function, a delay and a behavior in any
 * order and the rest at their initial values, the first time the duration
 * and the second the delay — or null where an item is not one, or where
 * `none` is one of several (CSS Transitions 1, 2.5; 2, 2.1).
 */
export function parseTransition(value: string): Transitions | null {
  // one object for one value: a reset gives every element the same, and
  // what a list runs on is kept by the list (`transitionFields`)
  let parsed = PARSED_TRANSITIONS.get(value);
  if (parsed === undefined) {
    if (PARSED_TRANSITIONS.size >= 256) PARSED_TRANSITIONS.clear();
    parsed = readTransition(value);
    PARSED_TRANSITIONS.set(value, parsed);
  }
  return parsed;
}

const PARSED_TRANSITIONS = new Map<string, Transitions | null>();

function readTransition(value: string): Transitions | null {
  const properties: string[] = [];
  const durations: number[] = [];
  const easings: Easing[] = [];
  const delays: number[] = [];
  const behaviors: TransitionBehavior[] = [];
  const items = splitCommas(value);
  for (const item of items) {
    const tokens = splitValue(item.trim());
    if (!tokens.length) return null;
    // null for `none`
    let property: string | null | undefined;
    let time = 0;
    let dur: number | undefined;
    let del: number | undefined;
    let easing: Easing | undefined;
    let behavior: TransitionBehavior | undefined;
    for (const token of tokens) {
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
      const lower = token.toLowerCase();
      if (behavior === undefined && BEHAVIORS.has(lower)) {
        behavior = lower as TransitionBehavior;
        continue;
      }
      if (property !== undefined) return null;
      if (lower === 'none') {
        property = null;
        continue;
      }
      const name = transitionProperty(token);
      if (name === undefined) return null;
      property = name;
    }
    if (property === null) {
      if (items.length > 1) return null;
    } else {
      properties.push(property ?? 'all');
    }
    durations.push(dur ?? 0);
    easings.push(easing ?? EASE);
    delays.push(del ?? 0);
    behaviors.push(behavior ?? 'normal');
  }
  return { properties, durations, easings, delays, behaviors };
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

// --- time ---------------------------------------------------------------------

/** Where an easing function takes an input progress, 0 to 1 (CSS Easing
 *  2): the same for the identity, a cubic Bézier's curve, the step it is
 *  on, or a `linear()`'s line between the points around it. */
export function ease(easing: Easing, t: number): number {
  switch (easing.type) {
    case 'linear':
      return t;
    case 'cubic':
      return bezier(easing, t);
    case 'steps':
      return steps(easing.count, easing.position, t);
    case 'points':
      return pointsAt(easing.points, t);
  }
}

/** A cubic Bézier from (0, 0) to (1, 1): the y where its x is `t`, the
 *  curve's parameter found by Newton's method, and by halving where that
 *  does not settle. */
function bezier(
  { x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number },
  t: number,
): number {
  if (t <= 0 || t >= 1) return t <= 0 ? 0 : 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xAt = (s: number) => ((ax * s + bx) * s + cx) * s;
  const yAt = (s: number) => ((ay * s + by) * s + cy) * s;
  let s = t;
  for (let i = 0; i < 8; i += 1) {
    const x = xAt(s) - t;
    if (Math.abs(x) < 1e-7) return yAt(s);
    const slope = (3 * ax * s + 2 * bx) * s + cx;
    if (Math.abs(slope) < 1e-6) break;
    s -= x / slope;
  }
  let lo = 0;
  let hi = 1;
  s = t;
  for (let i = 0; i < 40; i += 1) {
    const x = xAt(s);
    if (Math.abs(x - t) < 1e-7) break;
    if (t > x) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return yAt(s);
}

/** The step `t` is on, as a fraction of the way (CSS Easing 2, 3.1). */
function steps(count: number, position: StepPosition, t: number): number {
  let step = Math.floor(t * count);
  if (position === 'jump-start' || position === 'jump-both') step += 1;
  const jumps =
    position === 'jump-both'
      ? count + 1
      : position === 'jump-none'
        ? count - 1
        : count;
  if (t >= 0 && step < 0) step = 0;
  if (t <= 1 && step > jumps) step = jumps;
  return step / jumps;
}

/** A `linear()`'s output at `t`: on the line between the points around it,
 *  the last of several at one input from that input on. */
function pointsAt(
  points: readonly { input: number; output: number }[],
  t: number,
): number {
  if (t <= points[0].input) return points[0].output;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const a = points[i];
    if (a.input > t) continue;
    const b = points[i + 1];
    if (!b) return a.output;
    if (b.input === a.input) return b.output;
    return (
      a.output + ((b.output - a.output) * (t - a.input)) / (b.input - a.input)
    );
  }
  return points[points.length - 1].output;
}

/** One animation's timing, from its longhands. */
export interface Timing {
  /** Milliseconds an iteration takes. */
  duration: number;
  /** Milliseconds before the first starts; less than none starts it part
   *  of the way through. */
  delay: number;
  /** How many iterations: `Infinity` for ever, and a fraction ends part of
   *  the way through one. */
  iterations: number;
  direction: AnimationDirection;
  fill: FillMode;
}

/** The timing of the animation at `index` in an element's lists, a shorter
 *  list repeating as it does (CSS Animations 1, 4). */
export function timingAt(animations: Animations, index: number): Timing {
  const at = <T>(list: readonly T[]): T => list[index % list.length];
  return {
    duration: at(animations.durations),
    delay: at(animations.delays),
    iterations: at(animations.iterations),
    direction: at(animations.directions),
    fill: at(animations.fillModes),
  };
}

/** Whether an animation has yet to start, is under way, or is over. */
export type Phase = 'before' | 'active' | 'after';

/**
 * How far through the frames of its current iteration an animation is,
 * `time` milliseconds after it started — 0 at its `from`, 1 at its `to` —
 * and its phase (Web Animations 1, 4.8 to 4.10). The progress is null
 * where the animation has no effect: before its delay unless it fills
 * backwards, and after its end unless it fills forwards. An iteration that
 * ends where the next begins is at 1, so an animation that fills forwards
 * holds its `to` and not its `from`; and one that alternates plays its odd
 * iterations backwards.
 */
export function progressAt(
  timing: Timing,
  time: number,
): { progress: number | null; phase: Phase } {
  const { duration, delay, iterations, direction, fill } = timing;
  const active = duration === 0 || iterations === 0 ? 0 : duration * iterations;
  const end = Math.max(delay + active, 0);
  const beforeActive = Math.max(Math.min(delay, end), 0);
  const activeAfter = Math.max(Math.min(delay + active, end), 0);
  const phase: Phase =
    time < beforeActive ? 'before' : time >= activeAfter ? 'after' : 'active';
  let activeTime: number | null;
  if (phase === 'before') {
    activeTime =
      fill === 'backwards' || fill === 'both'
        ? Math.max(time - delay, 0)
        : null;
  } else if (phase === 'active') {
    activeTime = time - delay;
  } else {
    activeTime =
      fill === 'forwards' || fill === 'both'
        ? Math.max(Math.min(time - delay, active), 0)
        : null;
  }
  if (activeTime === null) return { progress: null, phase };
  const overall =
    duration === 0
      ? phase === 'before'
        ? 0
        : iterations
      : activeTime / duration;
  let simple = overall === Infinity ? 0 : overall % 1;
  if (
    simple === 0 &&
    phase !== 'before' &&
    activeTime === active &&
    iterations !== 0
  ) {
    simple = 1;
  }
  let iteration: number;
  if (phase === 'after' && iterations === Infinity) iteration = Infinity;
  else if (simple === 1) iteration = Math.floor(overall) - 1;
  else iteration = Math.floor(overall);
  let forwards = direction === 'normal' || direction === 'alternate';
  if (direction === 'alternate' || direction === 'alternate-reverse') {
    const turn = direction === 'alternate-reverse' ? iteration + 1 : iteration;
    forwards = turn === Infinity || turn % 2 === 0;
  }
  return { progress: forwards ? simple : 1 - simple, phase };
}

/** One frame of a property's: where it is, the declaration it gives the
 *  property, the frame that is in — whose other declarations it is
 *  computed among — and the easing to the next frame of the property's. */
export interface TrackFrame {
  offset: number;
  declaration: Declaration;
  frame: Keyframe;
  easing: Easing | null;
}

/**
 * A `@keyframes` by property: for each property its frames set, those
 * frames in order of offset, one at an offset — a later frame's
 * declaration over an earlier one's there (CSS Animations 1, 3). Kept by
 * the rule.
 */
export function tracksOf(
  rule: KeyframesRule,
): ReadonlyMap<string, readonly TrackFrame[]> {
  const known = TRACKS.get(rule);
  if (known) return known;
  const byProp = new Map<string, Map<number, TrackFrame>>();
  for (const frame of rule.frames) {
    const easing = frame.easing === null ? null : parseEasing(frame.easing);
    for (const offset of frame.offsets) {
      for (const declaration of frame.declarations) {
        let at = byProp.get(declaration.prop);
        if (!at) byProp.set(declaration.prop, (at = new Map()));
        at.set(offset, { offset, declaration, frame, easing });
      }
    }
  }
  const tracks = new Map<string, readonly TrackFrame[]>();
  for (const [prop, at] of byProp) {
    tracks.set(
      prop,
      [...at.values()].sort((a, b) => a.offset - b.offset),
    );
  }
  TRACKS.set(rule, tracks);
  return tracks;
}

const TRACKS = new WeakMap<
  KeyframesRule,
  ReadonlyMap<string, readonly TrackFrame[]>
>();

/**
 * Where a property is between its frames at an iteration's progress: the
 * frame before and the frame after — null for the element's own value,
 * where no frame is at 0 or at 1 and one is made of it (CSS Animations 1,
 * 3) — and how far between them it is, eased by the earlier frame's
 * easing, or the animation's.
 */
export function spanAt(
  frames: readonly TrackFrame[],
  progress: number,
  easing: Easing,
): { from: TrackFrame | null; to: TrackFrame | null; q: number } {
  const points: { offset: number; frame: TrackFrame | null }[] = [];
  if (frames[0].offset > 0) points.push({ offset: 0, frame: null });
  for (const frame of frames) points.push({ offset: frame.offset, frame });
  if (frames[frames.length - 1].offset < 1) {
    points.push({ offset: 1, frame: null });
  }
  let at = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    if (points[i].offset <= progress) at = i;
  }
  const a = points[at];
  const b = points[at + 1];
  const width = b.offset - a.offset;
  const local = width > 0 ? (progress - a.offset) / width : 1;
  const t = local < 0 ? 0 : local > 1 ? 1 : local;
  return { from: a.frame, to: b.frame, q: ease(a.frame?.easing ?? easing, t) };
}
