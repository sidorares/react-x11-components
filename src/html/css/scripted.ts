// The animations a page's scripts make (`Element.animate()`, `new
// Animation(new KeyframeEffect(…))`, Web Animations 1), as `<Html>` draws
// them.
//
// The page's realm keeps each one's timing — its promises, its events, when
// it finishes (`scripts/dom.ts`) — and tells the host, as primitives, what
// its effect is and where its time is whenever either changes: the frames,
// each at its computed offset with its easing and its property values, the
// timing, and the animation's own time at that moment, the rate it moves
// at and whether it is held (the `animation` op). They are kept here by
// element, the frames a `KeyframesRule` as a `@keyframes` block's are, so
// the cascade samples one as it samples a CSS animation and applies what it
// comes to at the animation origin — above every CSS animation, and in the
// order they were made, which is the order they composite in (Web
// Animations 1, 5.4.2).
//
// Its time is the page's: the host keeps the time it was told and the
// animation clock's time then, and a sample is that time moved on by the
// rate for as long as the clock has run since. A held one — paused,
// finished, at a rate of 0 — is where it was told it is, so a finished
// animation is drawn where the page's timing ended it, and its fill decides
// what it leaves.

import { ease, parseEasing, steepest, tracksOf } from './animation.js';
import type {
  AnimationDirection,
  Easing,
  FillMode,
  Phase,
} from './animation.js';
import { keyframeDeclaration } from './parse.js';
import type { Declaration, Keyframe, KeyframesRule } from './parse.js';
import { animatedWillChange, animatesInherited } from './timeline.js';
import type { Sample } from './timeline.js';

/** Which of an element's boxes an animation is of: its own, or its
 *  `::before`'s or `::after`'s (`KeyframeEffect.pseudoElement`). */
export type ScriptPseudo =
  | ''
  | 'before'
  | 'after'
  // one of a view transition's, by its key (`HtmlViewNode._transitionTree`)
  | `view-transition${string}`;

/** A view transition's pseudo-element as an effect names it: the tree's
 *  root, or a part and its name. */
const TRANSITION_PSEUDO =
  /^view-transition(?:-(?:group|image-pair|old|new)\([^()\s]+\))?$/;

/** A script animation's effect timing (Web Animations 1, 4.11), checked:
 *  a `fill` of `auto` is `none` for a keyframe effect, and a duration of
 *  `auto` is 0. */
export interface ScriptTiming {
  delay: number;
  endDelay: number;
  fill: FillMode;
  iterationStart: number;
  iterations: number;
  duration: number;
  direction: AnimationDirection;
  easing: Easing;
}

/** One animation a page's script made, as the host was last told it. */
export interface ScriptAnimation {
  /** Which it is: made in this order, which is its composite order. */
  readonly id: number;
  readonly pseudo: ScriptPseudo;
  /** The effect as the page described it, which a change compares with:
   *  an unchanged one keeps its rule, which the cascade's caches go by. */
  readonly effect: string;
  readonly rule: KeyframesRule;
  readonly timing: ScriptTiming;
  /** Its own time at `at`, on the animation clock. */
  readonly base: number;
  readonly at: number;
  /** Its playback rate, which says which way it plays, and whether it
   *  moves from `base` at that rate or is held there. */
  readonly rate: number;
  readonly running: boolean;
}

const LINEAR: Easing = { type: 'linear' };

/**
 * The script animations of a document's elements, by element, each list in
 * the order the animations were made.
 */
export class ScriptAnimations {
  private _of = new Map<object, ScriptAnimation[]>();
  /** The last animation `of` lists: `commitStyles` asks what the effect
   *  stack comes to with one animation at the top of it (Web Animations 1,
   *  6.4), so those made after it are left out while it asks. */
  until = Infinity;

  get empty(): boolean {
    return this._of.size === 0;
  }

  /** Whether an element has an animation a script made, of its own or of
   *  a pseudo-element's: its style is its alone. */
  has(el: object): boolean {
    return this._of.size > 0 && this._of.has(el);
  }

  /** An element's animations, or a pseudo-element's, in their composite
   *  order; null where it has none. */
  of(el: object, pseudo: string): readonly ScriptAnimation[] | null {
    if (this._of.size === 0) return null;
    const all = this._of.get(el);
    if (!all) return null;
    let out: ScriptAnimation[] | null = null;
    for (const a of all) {
      if (a.pseudo !== pseudo || a.id > this.until) continue;
      (out ??= []).push(a);
    }
    return out;
  }

  /** One of an element's animations, by its id. */
  get(el: object, id: number): ScriptAnimation | undefined {
    return this._of.get(el)?.find((a) => a.id === id);
  }

  /**
   * What the page says of one of an element's animations: its effect and
   * where its time is (`readEffect`, `readPlay`), as of the clock's `now`;
   * or, with either null, that it has none — it was cancelled, it is idle,
   * it was replaced, or its effect is another element's now. Which of the
   * element's boxes changed: the one it was of, and the one it is of.
   */
  tell(
    el: object,
    id: number,
    effect: string | null,
    play: string | null,
    now: number,
  ): ScriptPseudo[] {
    let list = this._of.get(el);
    const index = list ? list.findIndex((a) => a.id === id) : -1;
    const was = index >= 0 ? list![index] : null;
    const touched: ScriptPseudo[] = was ? [was.pseudo] : [];
    const read =
      effect === null || play === null
        ? null
        : was?.effect === effect
          ? was
          : readEffect(effect);
    const time = read && play !== null ? readPlay(play) : null;
    if (!read || !time) {
      if (was) {
        list!.splice(index, 1);
        if (!list!.length) this._of.delete(el);
      }
      return touched;
    }
    const animation: ScriptAnimation = {
      id,
      pseudo: read.pseudo,
      effect: effect!,
      rule: read.rule,
      timing: read.timing,
      base: time.time,
      at: now,
      rate: time.rate,
      running: time.running,
    };
    if (!list) this._of.set(el, (list = []));
    if (was) list[index] = animation;
    else {
      let at = list.length;
      while (at > 0 && list[at - 1].id > id) at -= 1;
      list.splice(at, 0, animation);
    }
    if (!touched.includes(animation.pseudo)) touched.push(animation.pseudo);
    return touched;
  }

  /** Every element's animations are gone: the document is another. */
  clear(): void {
    this._of.clear();
  }
}

/**
 * An effect as the page's realm describes it, or null where it is not one:
 * a JSON array of the pseudo-element, the frames — each its computed
 * offset, its easing and its properties' values, by the CSS name of each —
 * and the timing (`KeyframeEffect._hostEffect`, `scripts/dom.ts`).
 */
export function readEffect(
  json: string,
): { pseudo: ScriptPseudo; rule: KeyframesRule; timing: ScriptTiming } | null {
  let given: unknown;
  try {
    given = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(given) || given.length !== 3) return null;
  const [p, f, t] = given as unknown[];
  const pseudo =
    p === 'before' || p === 'after' || p === ''
      ? p
      : typeof p === 'string' && TRANSITION_PSEUDO.test(p)
        ? (p as ScriptPseudo)
        : null;
  if (pseudo === null || !Array.isArray(f) || !Array.isArray(t)) return null;
  const timing = readTiming(t);
  if (!timing) return null;
  const frames: Keyframe[] = [];
  for (const frame of f as unknown[]) {
    if (!Array.isArray(frame) || frame.length !== 3) return null;
    const [offset, easing, props] = frame as unknown[];
    // a frame at a timeline offset may be placed outside the iteration
    if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
    if (typeof easing !== 'string' || !Array.isArray(props)) return null;
    const declarations: Declaration[] = [];
    for (const pair of props as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2) return null;
      const [name, value] = pair as unknown[];
      if (typeof name !== 'string' || typeof value !== 'string') return null;
      const d = keyframeDeclaration(name, value);
      if (d) declarations.push(d);
    }
    // the easing to the next frame, linear where it says none (Web
    // Animations 1, 6.6.1): an easing that is not one is linear too
    frames.push({
      offsets: [offset],
      declarations,
      easing: easing === 'linear' ? null : easing,
    });
  }
  return {
    pseudo,
    rule: { name: '', prefixed: false, frames, media: null, layer: null },
    timing,
  };
}

const FILLS = new Set(['none', 'forwards', 'backwards', 'both', 'auto']);
const DIRECTIONS = new Set([
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
]);

function readTiming(t: unknown[]): ScriptTiming | null {
  if (t.length !== 8) return null;
  const [delay, endDelay, fill, start, iterations, duration, direction, ez] = t;
  const finite = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v);
  if (!finite(delay) || !finite(endDelay)) return null;
  if (!finite(start) || start < 0) return null;
  // `Infinity` is no JSON number, and comes as null
  const count = iterations === null ? Infinity : iterations;
  if (typeof count !== 'number' || !(count >= 0)) return null;
  if (!finite(duration) || duration < 0) return null;
  if (typeof fill !== 'string' || !FILLS.has(fill)) return null;
  if (typeof direction !== 'string' || !DIRECTIONS.has(direction)) {
    return null;
  }
  return {
    delay,
    endDelay,
    fill: fill === 'auto' ? 'none' : (fill as FillMode),
    iterationStart: start,
    iterations: count,
    duration,
    direction: direction as AnimationDirection,
    easing: (typeof ez === 'string' && parseEasing(ez)) || LINEAR,
  };
}

/** Where an animation's time is, as the page tells it: `1,<time>,<rate>`
 *  for one running from that time at that rate, and `0,<time>,<rate>` for
 *  one held there. Null where it is neither. */
export function readPlay(
  play: string,
): { time: number; rate: number; running: boolean } | null {
  const [run, t, r] = play.split(',');
  const time = Number(t);
  const rate = Number(r);
  if ((run !== '0' && run !== '1') || !Number.isFinite(time)) return null;
  if (!Number.isFinite(rate)) return null;
  return { time, rate, running: run === '1' };
}

/**
 * Where a keyframe effect is at one of its animation's own times (Web
 * Animations 1, 4.8 to 4.11): its phase, and its transformed progress — the
 * iteration's progress the way its direction plays it, through its easing
 * — or null where it has no effect, before its delay unless it fills
 * backwards and after its end unless it fills forwards. `backwards` is
 * whether the animation plays backwards, at a negative rate, which puts a
 * time on a boundary in the phase it is heading out of. The iteration's
 * start, the end delay and the effect's easing are the three things a CSS
 * animation's timing has none of (`progressAt`).
 */
export function scriptProgress(
  timing: ScriptTiming,
  local: number,
  backwards: boolean,
): {
  progress: number | null;
  phase: Phase;
  /** Whether the directed progress grows with the active time. */
  directed: boolean;
  /** The active phase's bounds, in the animation's own time. */
  beforeActive: number;
  activeAfter: number;
} {
  const { duration, delay, iterations, iterationStart, fill } = timing;
  const active = duration === 0 || iterations === 0 ? 0 : duration * iterations;
  const end = Math.max(delay + active + timing.endDelay, 0);
  const beforeActive = Math.max(Math.min(delay, end), 0);
  const activeAfter = Math.max(Math.min(delay + active, end), 0);
  const phase: Phase =
    local < beforeActive || (backwards && local === beforeActive)
      ? 'before'
      : local > activeAfter || (!backwards && local === activeAfter)
        ? 'after'
        : 'active';
  let activeTime: number | null;
  if (phase === 'before') {
    activeTime =
      fill === 'backwards' || fill === 'both'
        ? Math.max(local - delay, 0)
        : null;
  } else if (phase === 'active') {
    activeTime = local - delay;
  } else {
    activeTime =
      fill === 'forwards' || fill === 'both'
        ? Math.max(Math.min(local - delay, active), 0)
        : null;
  }
  if (activeTime === null) {
    return { progress: null, phase, directed: true, beforeActive, activeAfter };
  }
  let overall =
    duration === 0
      ? phase === 'before'
        ? 0
        : iterations
      : activeTime / duration;
  overall += iterationStart;
  let simple = overall === Infinity ? iterationStart % 1 : overall % 1;
  if (
    simple === 0 &&
    (phase === 'active' || phase === 'after') &&
    activeTime === active &&
    iterations !== 0
  ) {
    simple = 1;
  }
  let iteration: number;
  if (phase === 'after' && iterations === Infinity) iteration = Infinity;
  else if (simple === 1) iteration = Math.floor(overall) - 1;
  else iteration = Math.floor(overall);
  let directed =
    timing.direction === 'normal' || timing.direction === 'alternate';
  if (
    timing.direction === 'alternate' ||
    timing.direction === 'alternate-reverse'
  ) {
    const turn =
      timing.direction === 'alternate-reverse' ? iteration + 1 : iteration;
    directed = turn === Infinity || turn % 2 === 0;
  }
  const progress = ease(timing.easing, directed ? simple : 1 - simple);
  return { progress, phase, directed, beforeActive, activeAfter };
}

/** Whether an easing's output only ever grows with its input, so that a
 *  progress through it moves one way between two times. */
function monotonic(easing: Easing): boolean {
  switch (easing.type) {
    case 'linear':
    case 'steps':
      return true;
    case 'cubic':
      return (
        easing.y1 >= 0 && easing.y1 <= 1 && easing.y2 >= 0 && easing.y2 <= 1
      );
    case 'points':
      return easing.points.every(
        (p, i, all) => i === 0 || p.output >= all[i - 1].output,
      );
  }
}

/** What an element's script animations, or a pseudo-element's, come to at
 *  a time (`sampleScripts`). */
export interface ScriptSampling {
  /** Each with an effect, in their composite order; null where none has
   *  one. A sample's progress is the transformed progress, so its own
   *  easing is linear: a frame's easing still eases the span after it. */
  samples: Sample[] | null;
  /** When one waiting out its delay starts, on the clock — or one played
   *  backwards gets back to its end — and whether one is under way. */
  timed: number;
  active: boolean;
  /** Whether one sets an inherited property, which reaches what the
   *  element holds. */
  inherits: boolean;
  /** What the properties they set make of the element, as `will-change`
   *  naming them would, for each that is current or in effect. */
  willChange: number;
}

/**
 * An element's script animations at the clock's `now`, or at rest where
 * it is null (`<Html animate={false}>`): each drawn then as a CSS animation
 * at rest is, as it stands once it has run at no length — its end where it
 * fills forwards, and nothing where not.
 */
export function sampleScripts(
  list: readonly ScriptAnimation[],
  now: number | null,
): ScriptSampling {
  let samples: Sample[] | null = null;
  let timed = Infinity;
  let active = false;
  let inherits = false;
  let willChange = 0;
  for (const animation of list) {
    const { rule, timing } = animation;
    if (!rule.frames.length) continue;
    if (!inherits) inherits = animatesInherited(rule);
    if (now === null) {
      if (timing.fill !== 'forwards' && timing.fill !== 'both') continue;
      const rest = { ...timing, duration: 0, delay: 0, endDelay: 0 };
      const { progress } = scriptProgress(rest, 0, false);
      if (progress === null) continue;
      willChange |= animatedWillChange(rule);
      (samples ??= []).push({
        rule,
        progress,
        easing: LINEAR,
        duration: 0,
        forwards: true,
        left: 0,
      });
      continue;
    }
    const { rate } = animation;
    const moves = animation.running && rate !== 0;
    const local = animation.base + (moves ? (now - animation.at) * rate : 0);
    const { progress, phase, directed, beforeActive, activeAfter } =
      scriptProgress(timing, local, rate < 0);
    if (phase !== 'after' || progress !== null) {
      willChange |= animatedWillChange(rule);
    }
    let left = 0;
    if (moves) {
      if (phase === 'active') {
        active = true;
        left =
          rate > 0
            ? (activeAfter - local) / rate
            : (local - beforeActive) / -rate;
      } else if (phase === 'before' && rate > 0) {
        timed = Math.min(timed, now + (beforeActive - local) / rate);
      } else if (phase === 'after' && rate < 0) {
        timed = Math.min(timed, now + (activeAfter - local) / rate);
      }
    }
    if (progress === null) continue;
    // How long the progress takes to cross the whole iteration at its
    // fastest, which is what says how soon a frame of it changes anything
    // (`Cascade._animatedDeclarations`): the effect's easing and the rate
    // both quicken it, and one that turns back on itself is a frame from
    // now.
    const steep = steepest(timing.easing);
    const duration =
      moves && monotonic(timing.easing) && steep < Infinity
        ? timing.duration / (Math.abs(rate) * Math.max(steep, 1e-9))
        : 0;
    (samples ??= []).push({
      rule,
      progress,
      easing: LINEAR,
      duration,
      forwards: directed === rate > 0,
      left,
    });
  }
  return { samples, timed, active, inherits, willChange };
}

/** The CSS properties an animation's frames set: what `commitStyles`
 *  writes into the element's `style` attribute. */
export function scriptProperties(animation: ScriptAnimation): string[] {
  return [...tracksOf(animation.rule).keys()];
}
