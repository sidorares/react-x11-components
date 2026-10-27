// A document's timeline (Web Animations 1, 4.3): when each element's
// animations started, and so how far through its frames each is now.
//
// The cascade asks it as it styles an animated element (`sample`), with the
// element's animation lists as they compute: an animation is the one of its
// name the element had the last time it was styled, which keeps the time it
// started — the first of that name, then the second, as CSS Animations 1
// matches them — and any other starts now. A paused one holds the time it
// had come to, and takes up from there when it plays again. One the lists
// no longer name is over, and so is every animation of an element a pass
// that styled the whole document did not style (`beginPass`): one in a
// subtree that stopped being displayed, or that left the document.
//
// It holds no element's style, and no reference to the tree: only the
// times, by element, so that a document built again finds them where it
// left them. What it says the element (`HtmlViewNode`) needs a frame for is
// what it restyles on the next one (`live`, `nextFrame`).

import { ease, progressAt, timingAt, tracksOf } from './animation.js';
import type { Animations, Easing, Timing, Transitions } from './animation.js';
import {
  discreteField,
  interpolateField,
  keywordSizes,
  same,
} from './interpolate.js';
import type { KeyframesRule } from './parse.js';
import type {
  AnimationAction,
  AnimationTrigger,
  RangeEdge,
  RangeName,
} from './triggers.js';
import type { ScriptSampling } from './scripted.js';
import {
  INHERITED,
  animatedFields,
  propertyOfField,
  copyStyle,
  isInherited,
  transitionableFields,
  willChangeOf,
} from './style.js';
import type { ComputedStyle, TimelineRef } from './style.js';

/** A key for each CSS animation's run, as a page's `CSSAnimation` is
 *  kept by it (`cssAnimations`). */
const RUN_KEYS = new WeakMap<Running, number>();
const TRANSIT_KEYS = new WeakMap<Transit, number>();

/** A CSS animation run's key, for as long as the run lasts. */
function runKey(run: Running): number {
  let key = RUN_KEYS.get(run);
  if (key === undefined) RUN_KEYS.set(run, (key = ++runKeys));
  return key;
}

/** A transition's key, kept across a seek (`seekTransition`). */
function transitKey(run: Transit): number {
  let key = TRANSIT_KEYS.get(run);
  if (key === undefined) TRANSIT_KEYS.set(run, (key = ++runKeys));
  return key;
}
let runKeys = 0;

/** How long a frame is: what an animation under way waits for its next. */
export const FRAME_MS = 16;

/** An animation at a time: the frames it runs, how far through them its
 *  iteration is — 0 at `from`, 1 at `to` — and its timing function, which
 *  eases each span between two frames. */
export interface Sample {
  rule: KeyframesRule;
  progress: number;
  easing: Easing;
  /** Milliseconds an iteration takes, whether the progress grows as time
   *  passes, and how long the animation goes on from now, 0 for one that
   *  holds where it is: what says how soon a frame of it changes anything
   *  (`pace`). */
  duration: number;
  forwards: boolean;
  left: number;
}

export interface Running {
  name: string;
  /** When it started, on the timeline: its time is the time since, or
   *  the time until where it plays backwards (`TriggerRun.rate`). */
  start: number;
  /** The time it is held at while paused, from its start; null while it
   *  plays. */
  hold: number | null;
  /** Where it waits for a trigger (`animation-trigger`): what the
   *  triggers it hears have made of it. */
  trig?: TriggerRun;
  /** Whether a page's script paused it (`CSSAnimation.pause()`), which
   *  holds it whatever `animation-play-state` says. */
  pagePaused?: boolean;
  /** Whether a page's script cancelled it (`CSSAnimation.cancel()`): it
   *  draws nothing while `animation-name` still names it. */
  pageCancelled?: boolean;
  /** Where its time is on a scroll's timeline, which `start` and `hold`,
   *  the clock's, are not (`ScrollRun`). */
  scroll?: ScrollRun;
  /** Whether it is new and waits, held at its start, for the paint that
   *  first shows it (`AnimationTimeline.startsAtPaint`). */
  pending?: boolean;
}

/**
 * A CSS animation's time on a scroll-driven timeline (Web Animations 2,
 * 4.4), in percentages of the timeline: held where it is paused — by
 * `animation-play-state` or by the page (`Running.pagePaused`) — and
 * otherwise the timeline's time less its start time, times its rate. Its
 * start time is its attachment range's start, or its end where it plays
 * backwards, aligned to the range at each sample, as "auto-align start
 * time" has it, until a page sets one (`seekScrolled`); and it aligns
 * again when it plays after a pause, as `play()` on such a timeline does.
 */
export interface ScrollRun {
  hold: number | null;
  /** The start time a page set, null while it is aligned to its range. */
  start: number | null;
  rate: number;
  /** Its time as last sampled, null where its timeline was inactive and
   *  nothing held it: what `getAnimations()` reads it as. */
  at: number | null;
}

/**
 * A triggered animation's play state (CSS Animation Triggers 1): held at
 * its start until a trigger it hears first does something to it
 * (`initial`), and then playing — forwards, or backwards at `rate` -1 —
 * paused, or finished at one end. `seen` is whether each trigger it hears
 * was active when it last heard, so that a change of it is an action.
 */
export interface TriggerRun {
  state: 'initial' | 'playing' | 'paused' | 'finished';
  rate: 1 | -1;
  /** Where it ends, from its start: its delay and its iterations. */
  end: number;
  triggers: readonly AnimationTrigger[];
  seen: Map<string, boolean>;
}

/** Where a scroll-driven animation's timeline is (Scroll-driven
 *  Animations 1): its progress, a percentage, and whether its scroller is
 *  at either end of its scroll, which puts a time on the end of the
 *  active phase in it (Web Animations 2, "at timeline boundary"). */
export interface ScrollProgress {
  at: number;
  edge: boolean;
  /** Where an edge of an attachment range is, on the same scale: `cover`'s
   *  for a view timeline, the scroll's for a scroll timeline. */
  edgeAt?: (edge: RangeEdge) => number;
  /** Whether it is a view timeline, which alone places a keyframe at a
   *  timeline offset (Scroll-driven Animations 1, 4.4). */
  view?: boolean;
}

interface Target {
  /** By the element's `animation-name` list, null where an entry is
   *  `none`. */
  running: (Running | null)[];
  /** The scroll-driven timelines its animations run on, their ranges,
   *  and where each was when it was last sampled — the timeline and the
   *  range's edges — what a scroll or a layout compares
   *  (`restyleScrolled`); and the timeline as it was then, which a style
   *  asked for between frames reads (`heldProgress`). */
  scrolled?: {
    refs: TimelineRef[];
    ranges: [RangeEdge | null, RangeEdge | null][];
    at: string[];
    progress: (ScrollProgress | null)[];
  };
  /** When it next changes: a frame from now while one is under way, the
   *  end of a delay before one starts, and never once each is over or
   *  paused. */
  next: number;
  /** When a delay of one ends, and whether one is under way, which is a
   *  frame from now until it says otherwise (`pace`). */
  timed: number;
  active: boolean;
  /** Whether a property it animates is inherited, which reaches what the
   *  element holds. */
  inherits: boolean;
  /** What the properties its current animations set make of the element,
   *  as `will-change` naming them would (`animatedWillChange`). */
  willChange: number;
  /** Whether one of them runs on the clock rather than on a scroll's
   *  timeline (`animatesOnClock`). */
  clocked?: boolean;
}

export class AnimationTimeline {
  /** The time the styles are computed at: the clock's, set before each
   *  pass that computes any. */
  now = 0;
  /** Where a scroll-driven timeline is for an element, or null where it
   *  is inactive: the element's to say, which knows the boxes and the
   *  scroll (`HtmlViewNode._timelineProgress`). With none, every such
   *  timeline is inactive. */
  scrollProgress:
    | ((el: object, pseudo: string, ref: TimelineRef) => ScrollProgress | null)
    | null = null;
  private _targets = new Map<object, Map<string, Target>>();
  /** The targets a pass that styles the whole document has styled. */
  private _seen: Set<Target> | null = null;
  /** Each element's transitions, and each pseudo-element's (''
   *  for the element's own), where one runs or has run to its end. */
  private _transitions = new Map<object, Map<string, Transiting>>();
  /** The transitions a pass that styles the whole document has styled. */
  private _seenTransits: Set<Transiting> | null = null;
  /** Where each transition was last seen to be, for the events its moving
   *  owes (`_seenAt`). This timeline's own: a fork shares the runs. */
  private _phases = new WeakMap<Transit, TransitPhase>();
  /** The transition events owed the page, in the order they came about
   *  (`takeCssEvents`). */
  private _cssEvents: CssEventRecord[] = [];
  /** Where each CSS animation's run was last seen to be, and in which
   *  iteration, for the events its moving owes (`_animationAt`). */
  private _runPhases = new WeakMap<
    Running,
    {
      phase: TransitPhase;
      iteration: number;
      delay: number;
      active: number;
      /** The time it was sampled at, and what makes a millisecond of it:
       *  1 on the clock's timeline, 1000 on a scroll's (`_animationAt`). */
      time: number;
      scale: number;
    }
  >();
  /** Told as an event is owed, so the element that tells them knows to
   *  (`HtmlViewNode._oweCssEvents`). A fork has none. */
  onCssEvent: (() => void) | null = null;
  /**
   * Whether a CSS animation the clock runs, or a transition, starts at the
   * paint that first shows it rather than as its style is first computed:
   * held at its start until then (`pending`), and running from that
   * paint's time on (`startPending`), as a browser holds a new animation —
   * a `CSSTransition` is one — until the frame that renders it (Web
   * Animations 1, 4.4.2, the ready time). A style is
   * computed well before the paint where a page asks for one or a build
   * is long — Radix reads a menu's `getComputedStyle` as it mounts it — and
   * a fade of 100ms was over before the menu was first drawn.
   */
  startsAtPaint = false;
  /** When the longest waiting of them was made, Infinity where none waits:
   *  one a paint does not show for long starts anyway (`startPending`). */
  pendingSince = Infinity;
  /**
   * Whether an animation's end waits for the page to hear of it: one that
   * runs out with its `animationend` not told yet is drawn as it ends, as
   * though it filled forwards, until it is (`releaseEnds`). A browser tells
   * the event before the frame that draws the element as the animation
   * leaves it, and a page that keeps the end — Radix sets
   * `animation-fill-mode: forwards` on a menu fading out as it unmounts it
   * — keeps it from that frame on. Told after, the menu was drawn whole
   * between its fade and its unmounting.
   */
  holdsEnds = false;
  /** The runs whose end waits to be told, with whose they are. */
  private _endsHeld = new Map<Running, { el: object; pseudo: string }>();
  /** Each element's animations a script made, or a pseudo-element's, as
   *  the cascade last sampled them (`noteScripts`): when they next change.
   *  The animations themselves are `ScriptAnimations`', the page's to make
   *  and end, and outlive this: a target here is only their clock. */
  private _scripts = new Map<object, Map<string, ScriptTarget>>();
  /** The script targets a pass that styles the whole document has styled. */
  private _seenScripts: Set<ScriptTarget> | null = null;

  /** A pass begins: where `whole`, it styles every element displayed, and
   *  ends every animation it does not reach (`endPass`). */
  beginPass(whole: boolean): void {
    this._seen = whole ? new Set() : null;
    this._seenTransits = whole ? new Set() : null;
    this._seenScripts = whole ? new Set() : null;
  }

  endPass(): void {
    const seen = this._seen;
    this._seen = null;
    const transits = this._seenTransits;
    this._seenTransits = null;
    const scripts = this._seenScripts;
    this._seenScripts = null;
    if (scripts) {
      // one not styled is not displayed, and draws no frame until it is
      // styled again, when it is sampled again
      for (const [el, targets] of this._scripts) {
        for (const [pseudo, target] of targets) {
          if (!scripts.has(target)) targets.delete(pseudo);
        }
        if (!targets.size) this._scripts.delete(el);
      }
    }
    if (transits) {
      // an element no longer styled is out of the document, or under
      // `display: none`: its transitions are over
      for (const [el, states] of this._transitions) {
        for (const [pseudo, state] of states) {
          if (transits.has(state)) continue;
          for (const run of state.running.values()) {
            this._cancelled(el, pseudo, run);
          }
          states.delete(pseudo);
        }
        if (!states.size) this._transitions.delete(el);
      }
    }
    if (!seen) return;
    for (const [el, targets] of this._targets) {
      for (const [pseudo, target] of targets) {
        if (seen.has(target)) continue;
        for (const run of target.running) {
          if (run) this._animationCancelled(el, pseudo, run);
        }
        targets.delete(pseudo);
      }
      if (!targets.size) this._targets.delete(el);
    }
  }

  /**
   * An element's animations at `now`, or a pseudo-element's (`pseudo`, ''
   * for the element's own), from its animation lists: each one with an
   * effect, in the order named, which is the order they stack in — a later
   * one over an earlier where both set a property. Null where none has an
   * effect now.
   */
  sample(
    el: object,
    pseudo: string,
    animations: Animations,
    keyframesOf: (name: string) => KeyframesRule | null,
    /** `animation-timeline`, by the same index: `auto` is the clock's. */
    timelines: readonly TimelineRef[] = [],
    /** `animation-range-start` and `-end`, by the same index. */
    rangeStarts: readonly RangeEdge[] = [],
    rangeEnds: readonly RangeEdge[] = [],
  ): Sample[] | null {
    let targets = this._targets.get(el);
    const was = targets?.get(pseudo)?.running ?? [];
    const taken = new Set<Running>();
    const running: (Running | null)[] = [];
    const now = this.now;
    let timed = Infinity;
    let active = false;
    let inherits = false;
    let willChange = 0;
    let out: Sample[] | null = null;
    let scrolled: Target['scrolled'] = undefined;
    let clocked = false;
    const { names, easings, playStates, triggers } = animations;
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (name === null) {
        running.push(null);
        continue;
      }
      let run = was.find((r) => r !== null && r.name === name && !taken.has(r));
      let fresh = false;
      if (!run) {
        run = { name, start: now, hold: null };
        fresh = true;
      }
      taken.add(run);
      running.push(run);
      if (run.pageCancelled) continue;
      // one on a scroll's timeline, or on none, is where the scroll has
      // it, and its clock is no part of it
      const ref = timelines.length ? timelines[i % timelines.length] : null;
      if (ref && ref.kind !== 'auto') {
        const p =
          ref.kind === 'none'
            ? null
            : (this.scrollProgress?.(el, pseudo, ref) ?? null);
        // where its range starts and ends on the timeline (5.1)
        const rangeStart = rangeStarts.length
          ? rangeStarts[i % rangeStarts.length]
          : null;
        const rangeEnd = rangeEnds.length
          ? rangeEnds[i % rangeEnds.length]
          : null;
        const from = p && rangeStart && p.edgeAt ? p.edgeAt(rangeStart) : 0;
        const to = p && rangeEnd && p.edgeAt ? p.edgeAt(rangeEnd) : 100;
        if (ref.kind !== 'none') {
          scrolled ??= { refs: [], ranges: [], at: [], progress: [] };
          scrolled.refs.push(ref);
          scrolled.ranges.push([rangeStart, rangeEnd]);
          scrolled.at.push(p ? `${p.at},${from},${to}` : '');
          scrolled.progress.push(p);
        }
        if (ref.kind === 'none') continue;
        // its time: the timeline's from its start time, or where it is
        // held — paused by its play state or by the page
        const s = (run.scroll ??= {
          hold: null,
          start: null,
          rate: 1,
          at: null,
        });
        const live = p
          ? (p.at - (s.start ?? (s.rate < 0 ? to : from))) * s.rate
          : null;
        if (playStates[i % playStates.length] === 'paused' || run.pagePaused) {
          s.hold ??= live;
        } else if (s.hold !== null) {
          // played again, it is aligned to its range again
          s.hold = null;
          s.start = null;
        }
        const local = s.hold ?? live;
        s.at = local;
        const named = keyframesOf(name);
        if (!named || local === null) continue;
        // a frame at a timeline offset is where that offset is in the
        // range, on a view timeline, and nowhere on any other
        const edgeAt = p?.edgeAt;
        const rule =
          p?.view && edgeAt && to - from > 0
            ? placedRule(
                named,
                (range) =>
                  (edgeAt({
                    name: range.name as RangeName,
                    offset: { pct: range.pct },
                  }) -
                    from) /
                  (to - from),
              )
            : named;
        if (!inherits) inherits = animatesInherited(rule);
        const timing = proportional(
          timingAt(animations, i),
          Math.max(to - from, 0),
        );
        const active =
          timing.duration === 0 || timing.iterations === 0
            ? 0
            : timing.duration * timing.iterations;
        const end = Math.max(timing.delay + active, 0);
        const activeAfter = Math.max(Math.min(timing.delay + active, end), 0);
        // at its scroller's end, the end of the active phase is in it:
        // it holds its end there as one that fills forwards would — where
        // its time is the timeline's, and not one held elsewhere
        const boundary =
          !!p?.edge &&
          local === live &&
          activeAfter > 0 &&
          Math.abs(local - activeAfter) < 1e-9;
        const fill =
          boundary && (timing.fill === 'none' || timing.fill === 'backwards')
            ? timing.fill === 'none'
              ? 'forwards'
              : 'both'
            : timing.fill;
        const at = progressAt({ ...timing, fill }, local);
        // and what its moving owes the page, as one on the clock's does
        this._animationAt(el, pseudo, run, timing, local, true, boundary);
        if (at.phase !== 'after' || at.progress !== null) {
          willChange |= animatedWillChange(rule);
        }
        if (at.progress === null) continue;
        (out ??= []).push({
          rule,
          progress: at.progress,
          easing: easings[i % easings.length],
          duration: timing.duration,
          forwards: s.rate < 0 ? !at.forwards : at.forwards,
          // it moves as the scroll does, which asks for its frames
          left: 0,
        });
        continue;
      }
      const timing = timingAt(animations, i);
      clocked = true;
      // new, it waits at its start for the paint that first shows it
      if (fresh && this.startsAtPaint) {
        run.hold = 0;
        run.pending = true;
        this.pendingSince = Math.min(this.pendingSince, now);
      }
      // one that waits for a trigger is held at its start until one does
      // something to it, and plays as its triggers have it after that
      const heard = triggers[i % triggers.length];
      if (heard && !run.trig) {
        run.trig = {
          state: 'initial',
          rate: 1,
          end: 0,
          triggers: heard,
          seen: new Map(),
        };
        run.hold = 0;
      } else if (!heard && run.trig) {
        if (run.trig.rate < 0 && run.hold === null) {
          run.hold = run.start - now;
        }
        delete run.trig;
      }
      const trig = run.trig;
      const rate = trig?.rate ?? 1;
      if (trig) {
        trig.triggers = heard!;
        trig.end = Math.max(
          0,
          timing.delay + timing.duration * timing.iterations,
        );
      }
      const paused =
        playStates[i % playStates.length] === 'paused' ||
        !!run.pagePaused ||
        (!!trig && trig.state !== 'playing');
      // paused, it holds where it is whatever paints; it waits for none
      if (paused) run.pending = false;
      if (paused && run.hold === null) {
        run.hold = rate * (now - run.start);
      } else if (!paused && run.hold !== null && !run.pending) {
        run.start = now - rate * run.hold;
        run.hold = null;
      }
      // played to one end, it is finished there
      if (trig?.state === 'playing') {
        const t = rate * (now - run.start);
        if (rate > 0 ? t >= trig.end : t <= 0) {
          trig.state = 'finished';
          run.hold = rate > 0 ? trig.end : 0;
        }
      }
      const held = paused || trig?.state === 'finished';
      const rule = keyframesOf(name);
      if (!rule) continue;
      if (!inherits) inherits = animatesInherited(rule);
      const time = run.hold ?? rate * (now - run.start);
      // waiting for its paint it has not started, and owes nothing yet
      if (!run.pending) this._animationAt(el, pseudo, run, timing, time);
      // run out, and its end not told yet: drawn as it ends
      const at = progressAt(
        this._endsHeld.has(run) ? filledForwards(timing) : timing,
        time,
      );
      const { progress, phase } = at;
      // played backwards, it changes the other way, and goes on until its
      // start
      const forwards = rate > 0 ? at.forwards : !at.forwards;
      const left = rate > 0 ? at.left : Math.max(0, time - timing.delay);
      // in its delay, under way, or filling forwards: what it sets acts as
      // named in `will-change` (Web Animations 1, 5.6)
      if (phase !== 'after' || progress !== null) {
        willChange |= animatedWillChange(rule);
      }
      if (!held) {
        if (phase === 'active') active = true;
        else if (phase === 'before') {
          // backwards through its delay, it finishes at its start; and
          // waiting for its paint, its delay is counted from now
          timed = Math.min(
            timed,
            rate > 0
              ? (run.pending ? now : run.start) + timing.delay
              : run.start,
          );
        }
      }
      if (progress === null) continue;
      (out ??= []).push({
        rule,
        progress,
        easing: easings[i % easings.length],
        duration: timing.duration,
        forwards,
        // a paused one, or one before or after its active phase, holds
        left: !held && phase === 'active' ? left : 0,
      });
    }
    // one the list no longer names is cancelled
    for (const run of was) {
      if (run && !taken.has(run)) this._animationCancelled(el, pseudo, run);
    }
    if (!taken.size) {
      this.drop(el, pseudo);
      return null;
    }
    if (!targets) this._targets.set(el, (targets = new Map()));
    const next = Math.min(timed, active ? now + FRAME_MS : Infinity);
    const target: Target = {
      running,
      next,
      timed,
      active,
      inherits,
      willChange,
      scrolled,
      clocked,
    };
    targets.set(pseudo, target);
    this._seen?.add(target);
    if (this._sought.size) this._sought.delete(el);
    return out;
  }

  /** The elements a page did something to a scroll-driven animation of
   *  since they were last styled (`seekScrolled`, `cancelAnimation`): what
   *  a style asked for before the next frame works out again (`sought`). */
  private _sought = new Set<object>();

  /** Whether a page did something to one of an element's scroll-driven
   *  animations since it was last styled, or to one of its
   *  pseudo-elements'. */
  sought(el: object): boolean {
    return this._sought.size > 0 && this._sought.has(el);
  }

  /**
   * Where a scroll-driven timeline was for an element as it was last
   * styled, or for a pseudo-element: what a style asked for between frames
   * reads, as a browser's timeline holds its time from one frame to the
   * next (Scroll-driven Animations 1, 6.1) — and where it is now, for one
   * the element was not styled with.
   */
  heldProgress = (
    el: object,
    pseudo: string,
    ref: TimelineRef,
  ): ScrollProgress | null => {
    const scrolled = this._targets.get(el)?.get(pseudo)?.scrolled;
    if (scrolled) {
      const i = scrolled.refs.findIndex((r) => r === ref || sameRef(r, ref));
      if (i >= 0) return scrolled.progress[i];
    }
    return this.scrollProgress?.(el, pseudo, ref) ?? null;
  };

  /**
   * A scroll or a layout moved: each element whose scroll-driven
   * animations' timelines are somewhere else now is styled again at the
   * next frame. Whether any is.
   */
  restyleScrolled(): boolean {
    const progress = this.scrollProgress;
    if (!progress) return false;
    let any = false;
    for (const [el, targets] of this._targets) {
      for (const [pseudo, target] of targets) {
        const scrolled = target.scrolled;
        if (!scrolled || target.next === 0) continue;
        const moved = scrolled.refs.some((ref, i) => {
          const p = progress(el, pseudo, ref);
          const [start, end] = scrolled.ranges[i];
          const from = start && p?.edgeAt ? p.edgeAt(start) : 0;
          const to = end && p?.edgeAt ? p.edgeAt(end) : 100;
          return (p ? `${p.at},${from},${to}` : '') !== scrolled.at[i];
        });
        if (moved) {
          target.next = 0;
          any = true;
        }
      }
    }
    return any;
  }

  /**
   * The CSS animations under way, each its element, its pseudo-element (''
   * for the element's own), its place in its `animation-name` list, its
   * name, its run and a key that is its run's for as long as the run lasts:
   * what a page's `getAnimations()` lists as a `CSSAnimation` each.
   */
  cssAnimations(): {
    el: object;
    pseudo: string;
    index: number;
    name: string;
    run: Running;
    key: number;
  }[] {
    const out: {
      el: object;
      pseudo: string;
      index: number;
      name: string;
      run: Running;
      key: number;
    }[] = [];
    for (const [el, targets] of this._targets) {
      for (const [pseudo, target] of targets) {
        target.running.forEach((run, index) => {
          if (!run) return;
          out.push({
            el,
            pseudo,
            index,
            name: run.name,
            run,
            key: runKey(run),
          });
        });
      }
    }
    return out;
  }

  /** Whether an animation waits for a trigger, or did. */
  get triggered(): boolean {
    for (const targets of this._targets.values()) {
      for (const target of targets.values()) {
        if (target.running.some((run) => run?.trig)) return true;
      }
    }
    return false;
  }

  /**
   * What the triggers the animations hear make of them now: each run of an
   * animation that waits for a trigger takes the action its
   * `animation-trigger` names for a trigger that activated — `stateOf`
   * answering true — or deactivated since it last heard, and is restyled
   * at the next frame. A trigger `stateOf` finds none of, undefined, does
   * nothing: an animation that waits for one no element defines never
   * plays. The elements whose animations changed, which the caller asks a
   * frame for.
   */
  applyTriggers(
    stateOf: (el: object, name: string) => boolean | undefined,
  ): object[] {
    const out: object[] = [];
    for (const [el, targets] of this._targets) {
      let changed = false;
      for (const target of targets.values()) {
        let acted = false;
        for (const run of target.running) {
          const trig = run?.trig;
          if (!trig) continue;
          for (const { name, actions } of trig.triggers) {
            const state = stateOf(el, name);
            if (state === undefined) continue;
            if (state === (trig.seen.get(name) ?? false)) continue;
            trig.seen.set(name, state);
            const action = state ? actions[0] : actions[1];
            if (action && this._act(run!, trig, action)) acted = true;
          }
        }
        if (acted) {
          target.next = 0;
          changed = true;
        }
      }
      if (changed) out.push(el);
    }
    return out;
  }

  /**
   * An action on a triggered animation (CSS Animation Triggers 1,
   * `<animation-action>`), as Web Animations' methods are: `play` plays one
   * not playing — from its start again where it is finished at its end,
   * and from its end where it plays backwards and is finished at its start
   * — `play-once` only where it has not played or is paused, the two
   * directed ones set the way it plays first and play it, `pause` holds one
   * playing, and `reset` and `replay` take it to its start, the one held
   * there unless it never played and the other playing. Whether it changed.
   */
  private _act(
    run: Running,
    trig: TriggerRun,
    action: AnimationAction,
  ): boolean {
    const now = this.now;
    const time = () => run.hold ?? trig.rate * (now - run.start);
    const play = (): boolean => {
      if (trig.state === 'playing') return false;
      let t = time();
      if (trig.rate > 0 && t >= trig.end) t = 0;
      else if (trig.rate < 0 && t <= 0 && trig.end !== Infinity) t = trig.end;
      run.hold = null;
      run.start = now - trig.rate * t;
      trig.state = 'playing';
      return true;
    };
    const direct = (rate: 1 | -1): boolean => {
      if (trig.rate === rate) return play();
      const t = time();
      trig.rate = rate;
      if (run.hold === null) run.start = now - rate * t;
      play();
      return true;
    };
    const toStart = (): void => {
      if (run.hold !== null) run.hold = 0;
      else run.start = now;
    };
    switch (action) {
      case 'play':
        return play();
      case 'play-once':
        return (trig.state === 'initial' || trig.state === 'paused') && play();
      case 'play-forwards':
        return direct(1);
      case 'play-backwards':
        return direct(-1);
      case 'pause':
        if (trig.state !== 'playing') return false;
        run.hold = time();
        trig.state = 'paused';
        return true;
      case 'reset':
        toStart();
        if (trig.state !== 'initial') {
          run.hold = 0;
          trig.state = 'paused';
        }
        return true;
      case 'replay':
        toStart();
        play();
        return true;
      default:
        return false;
    }
  }

  /**
   * An element's animations under way, or a pseudo-element's, change
   * nothing anyone sees until `at` (`Cascade._animatedDeclarations`, from
   * the values each one's frames run between): its next frame is then,
   * rather than a frame from now, unless a delay ends sooner — and a frame
   * from now at the soonest. Zen Garden 214's enso turns from a scale of 1
   * to one of 3 in ten hours, which moves its edge an eighth of a pixel in
   * two seconds, and it had a frame forty times a second.
   */
  pace(el: object, pseudo: string, at: number): void {
    const target = this._targets.get(el)?.get(pseudo);
    if (!target?.active) return;
    target.next = Math.min(target.timed, Math.max(this.now + FRAME_MS, at));
  }

  /**
   * What an element's script animations, or a pseudo-element's, came to as
   * the cascade sampled them now (`sampleScripts`): when they next change —
   * `at`, where what they draw changes by nothing anyone sees until then,
   * as `pace` has it for a CSS animation. Null where it has none.
   */
  noteScripts(
    el: object,
    pseudo: string,
    sampling: ScriptSampling | null,
    at = 0,
  ): void {
    let targets = this._scripts.get(el);
    if (!sampling) {
      if (targets?.delete(pseudo) && !targets.size) this._scripts.delete(el);
      return;
    }
    const next = Math.min(
      sampling.timed,
      sampling.active ? Math.max(this.now + FRAME_MS, at) : Infinity,
    );
    if (!targets) this._scripts.set(el, (targets = new Map()));
    let target = targets.get(pseudo);
    if (!target) targets.set(pseudo, (target = { next, inherits: false }));
    target.next = next;
    target.inherits = sampling.inherits;
    this._seenScripts?.add(target);
  }

  /** Whether the timeline keeps a clock for an element's script
   *  animations, or a pseudo-element's. */
  hasScripts(el: object, pseudo: string): boolean {
    return this._scripts.size > 0 && !!this._scripts.get(el)?.has(pseudo);
  }

  /** A script changed one of an element's animations, or a
   *  pseudo-element's: it is restyled at the next frame, as one under way
   *  is, and sampled again there. */
  oweScripts(el: object, pseudo: string): void {
    let targets = this._scripts.get(el);
    if (!targets) this._scripts.set(el, (targets = new Map()));
    const target = targets.get(pseudo);
    if (target) target.next = 0;
    else targets.set(pseudo, { next: 0, inherits: false });
  }

  /** An element is not displayed: its script animations draw nothing, and
   *  ask for no frame, until it is styled again. */
  dropScripts(el: object): void {
    this._scripts.delete(el);
  }

  /** What an element's animations make of it, or a pseudo-element's, as
   *  `will-change` naming what they set would (`animatedWillChange`), as
   *  of the last time it was sampled: each from the start of its delay to
   *  its end, or for good where it fills forwards. 0 where it has none. */
  willChange(el: object, pseudo: string): number {
    return this._targets.get(el)?.get(pseudo)?.willChange ?? 0;
  }

  /** An element's animations, or a pseudo-element's, are over: its lists
   *  name none. */
  drop(el: object, pseudo: string): void {
    const targets = this._targets.get(el);
    const target = targets?.get(pseudo);
    if (!targets || !target) return;
    for (const run of target.running) {
      if (run) this._animationCancelled(el, pseudo, run);
    }
    targets.delete(pseudo);
    if (!targets.size) this._targets.delete(el);
  }

  /** The runs of an element's own animations, or of its `pseudo`'s, by
   *  its `animation-name` list as it was last styled — when each started,
   *  and the time a paused one holds — or null where it has none. */
  runsOf(
    el: object,
    pseudo = '',
  ): readonly (Readonly<Running> | null)[] | null {
    return this._targets.get(el)?.get(pseudo)?.running ?? null;
  }

  /**
   * A timeline holding one element's animations as this one has them, its
   * own and its pseudo-elements': what its style at another time is
   * computed against, `now` set to that time, leaving this one as it was.
   * A sprite's frames are sampled so (`src/html/sprites.ts`).
   */
  fork(el: object): AnimationTimeline {
    const fork = new AnimationTimeline();
    fork.now = this.now;
    const targets = this._targets.get(el);
    if (targets) {
      const copy = new Map<string, Target>();
      for (const [pseudo, target] of targets) {
        const running = target.running.map(
          (run) =>
            run && {
              ...run,
              trig: run.trig && { ...run.trig, seen: new Map(run.trig.seen) },
              scroll: run.scroll && { ...run.scroll },
            },
        );
        copy.set(pseudo, { ...target, running });
      }
      fork._targets.set(el, copy);
    }
    const transits = this._transitions.get(el);
    if (transits) {
      const copy = new Map<string, Transiting>();
      for (const [pseudo, state] of transits) {
        copy.set(pseudo, {
          ...state,
          running: new Map(state.running),
          completed: new Map(state.completed),
        });
      }
      fork._transitions.set(el, copy);
    }
    return fork;
  }

  /** Whether the timeline knows of no animation at all. */
  get empty(): boolean {
    return this._targets.size === 0;
  }

  /** Whether an animation of an element's, or of a pseudo-element of its,
   *  changes as time passes — of `pseudo`'s alone where it is given, ''
   *  for the element's own. */
  isLive(el: object, pseudo?: string): boolean {
    for (const all of [
      this._targets.get(el),
      this._transitions.get(el),
      this._scripts.get(el),
    ]) {
      if (!all) continue;
      if (pseudo !== undefined) {
        const one = all.get(pseudo);
        if (one !== undefined && one.next !== Infinity) return true;
        continue;
      }
      for (const one of all.values()) if (one.next !== Infinity) return true;
    }
    return false;
  }

  /** The elements with an animation that changes as time passes, and for
   *  each whether what it holds inherits what changes, whether one is a
   *  pseudo-element's, and whose they are ('' for the element's own) —
   *  but those `skip` says the frames of are not this timeline's to run:
   *  one the render server runs on a layer of its own. */
  live(skip: ((el: object, pseudo: string) => boolean) | null = null): {
    el: object;
    inherits: boolean;
    generated: boolean;
    targets: string[];
  }[] {
    const out: {
      el: object;
      inherits: boolean;
      generated: boolean;
      targets: string[];
    }[] = [];
    const byEl = new Map<
      object,
      { el: object; inherits: boolean; generated: boolean; targets: string[] }
    >();
    for (const all of [this._targets, this._transitions, this._scripts]) {
      for (const [el, targets] of all) {
        for (const [pseudo, target] of targets) {
          if (target.next === Infinity) continue;
          if (skip?.(el, pseudo)) continue;
          let entry = byEl.get(el);
          if (!entry) {
            entry = { el, inherits: false, generated: false, targets: [] };
            byEl.set(el, entry);
            out.push(entry);
          }
          if (!entry.targets.includes(pseudo)) entry.targets.push(pseudo);
          entry.inherits ||= target.inherits;
          entry.generated ||= pseudo !== '';
        }
      }
    }
    return out;
  }

  /** When an animation next changes, on the timeline; null where none
   *  will without a style change. One `skip` names is not counted
   *  (`live`). */
  nextFrame(
    skip: ((el: object, pseudo: string) => boolean) | null = null,
  ): number | null {
    let next = Infinity;
    for (const all of [this._targets, this._transitions, this._scripts]) {
      for (const [el, targets] of all) {
        for (const [pseudo, target] of targets) {
          if (target.next >= next || skip?.(el, pseudo)) continue;
          next = target.next;
        }
      }
    }
    return next === Infinity ? null : next;
  }

  /**
   * `after` — the style an element comes to now, with no transition: its
   * after-change style — with what its transitions make of it (CSS
   * Transitions 1, 3), or a pseudo-element's (`pseudo`, '' for the
   * element's own). A property the style's transitions name, whose value
   * the change from `before` — its style as the document has it, null
   * where it has none, which is no change to transition from — moves, and
   * whose two values interpolate, starts a transition from one to the
   * other; through its delay it holds where it starts. One under way whose
   * end the style no longer has turns back the way it came where that is
   * where it started, shortened to as much of it as it had come, and
   * otherwise runs from where it is to the new end; one whose property
   * the list no longer names is cancelled, and the property is at its value
   * after the change at once. `after` itself where
   * none runs, and a copy of it otherwise, each field a transition runs on
   * at its value at the timeline's time.
   *
   * A field an animation sets — in `after` (`animated`, the fields its
   * animations with an effect set: `fieldsAnimatedBy`) or in the style
   * before it (`noteAnimated`) — starts none: what changed it is the
   * animation, and a transition does not start when the computed value
   * changes as a result of one (CSS Transitions 1, 3). One under way on it
   * runs on beneath the animation to the end it had, and the animation's
   * value is the field's: a transition is composited before an animation
   * (CSS Transitions 2, 4.1).
   */
  transition(
    el: object,
    pseudo: string,
    after: ComputedStyle,
    before: () => ComputedStyle | null,
    animated: ReadonlySet<string> | null = null,
  ): ComputedStyle {
    const fields = transitionFields(after.transitions);
    let states = this._transitions.get(el);
    let state = states?.get(pseudo);
    if (!state && !fields.size) return after;
    const now = this.now;
    const list = after.transitions;
    let wasStyle: ComputedStyle | null | undefined;
    let was: Record<string, unknown> | null = null;
    let wasAnimated: ReadonlySet<string> | undefined;
    // Under `interpolate-size: allow-keywords` a size between a length and
    // a keyword runs as a `calc-size()` of the keyword (CSS Values 5,
    // 12.1): both ends are written so (`keywordSizes`), and so is what is
    // drawn while one runs, which the next change starts from
    let sized = after;
    if (
      after.interpolateSize === 'allow-keywords' &&
      (fields.has('heightSize') || fields.has('widthSize'))
    ) {
      wasStyle = before();
      was = wasStyle as unknown as Record<string, unknown> | null;
      if (wasStyle) {
        wasAnimated = ANIMATED_FIELDS.get(wasStyle);
        const pair = keywordSizes(wasStyle, after);
        if (pair) {
          sized = Object.assign(copyStyle(after), pair.now);
          was = Object.assign(
            copyStyle(wasStyle),
            pair.was,
          ) as unknown as Record<string, unknown>;
        }
      }
    }
    const a = sized as unknown as Record<string, unknown>;
    const running = state?.running ?? new Map<string, Transit>();
    const completed = state?.completed ?? new Map<string, unknown>();
    // one waiting for the paint that first shows it has only just begun
    for (const run of running.values()) if (run.pending) beginAt(run, now);
    // one run to its end and left there: a change from a frame a little
    // short of its end, as the document drew it last, is none
    for (const [field, end] of completed) {
      if (!same(end, a[field])) completed.delete(field);
    }
    for (const [field, index] of fields) {
      if (running.has(field) || completed.has(field)) continue;
      if (animated?.has(field)) continue;
      if (wasStyle === undefined) {
        wasStyle = before();
        was = wasStyle as unknown as Record<string, unknown> | null;
        if (wasStyle) wasAnimated = ANIMATED_FIELDS.get(wasStyle);
      }
      if (!was) break;
      if (wasAnimated?.has(field)) continue;
      const from = was[field];
      const to = a[field];
      if (same(from, to)) continue;
      // a value that does not interpolate goes over at once, but where the
      // transition says `allow-discrete` (CSS Transitions 2, 3.1)
      if (
        interpolateField(field, from, to, 0.5) === undefined &&
        item(list.behaviors, index) !== 'allow-discrete'
      ) {
        continue;
      }
      running.set(field, {
        ...this._made(),
        serial: ++transitSeq,
        property: propertyOfField(field, item(list.properties, index)),
        created: now,
        start: now + item(list.delays, index),
        duration: Math.max(0, item(list.durations, index)),
        easing: item(list.easings, index),
        from,
        to,
        back: from,
        shortening: 1,
      });
    }
    for (const [field, run] of running) {
      const index = fields.get(field);
      // no longer named, or of no length: cancelled, at its new value
      if (index === undefined) {
        this._cancelled(el, pseudo, run);
        running.delete(field);
        continue;
      }
      // beneath an animation, to the end it had
      if (animated?.has(field)) continue;
      const to = a[field];
      if (same(run.to, to)) continue;
      const current = transitValue(field, run, now);
      const delay = item(list.delays, index);
      const duration = Math.max(0, item(list.durations, index));
      const easing = item(list.easings, index);
      // whatever comes of it, this one is cancelled (CSS Transitions 1, 3)
      this._cancelled(el, pseudo, run);
      if (
        same(current, to) ||
        (interpolateField(field, current, to, 0.5) === undefined &&
          item(list.behaviors, index) !== 'allow-discrete')
      ) {
        running.delete(field);
        continue;
      }
      if (same(run.back, to)) {
        // back where it came from: as much of a whole one as it had come
        const done = ease(
          run.easing,
          run.duration > 0
            ? Math.min(1, Math.max(0, (now - run.start) / run.duration))
            : 1,
        );
        const shortening = Math.min(
          1,
          Math.max(0, Math.abs(done * run.shortening + 1 - run.shortening)),
        );
        running.set(field, {
          ...this._made(),
          serial: ++transitSeq,
          property: run.property,
          created: now,
          start: now + (delay < 0 ? delay * shortening : delay),
          duration: duration * shortening,
          easing,
          from: current,
          to,
          back: run.to,
          shortening,
        });
      } else {
        running.set(field, {
          ...this._made(),
          serial: ++transitSeq,
          property: run.property,
          created: now,
          start: now + delay,
          duration,
          easing,
          from: current,
          to,
          back: current,
          shortening: 1,
        });
      }
    }
    let out: ComputedStyle | null = null;
    let next = Infinity;
    let inherits = false;
    let willChange = 0;
    for (const [field, run] of running) {
      // waiting for its paint it has not begun, and owes nothing yet
      if (!run.pending) this._seenAt(el, pseudo, run, now);
      if (now >= run.start + run.duration) {
        running.delete(field);
        completed.set(field, run.to);
        continue;
      }
      // the animation's value is over it, and asks for its own frames
      if (animated?.has(field)) continue;
      // a size running as a `calc-size()` is drawn as one, its keyword and
      // all, which `sized` has
      out ??= copyStyle(
        sized !== after &&
          (running.has('heightSize') || running.has('widthSize'))
          ? sized
          : after,
      );
      (out as unknown as Record<string, unknown>)[field] = transitValue(
        field,
        run,
        now,
      );
      next = Math.min(next, now < run.start ? run.start : now + FRAME_MS);
      inherits ||= INHERITED_FIELDS.has(field);
      willChange |= willChangeOf(field);
    }
    if (!running.size && !completed.size) {
      if (state) {
        states!.delete(pseudo);
        if (!states!.size) this._transitions.delete(el);
      }
      return after;
    }
    if (!state) {
      state = { running, completed, next, inherits };
      if (!states) this._transitions.set(el, (states = new Map()));
      states.set(pseudo, state);
    } else {
      state.next = next;
      state.inherits = inherits;
    }
    this._seenTransits?.add(state);
    // a transition is an animation, and what it runs acts as `will-change`
    // names it (Web Animations 1, 5.6)
    if (out) out.willChange |= willChange;
    return out ?? after;
  }

  /**
   * The CSS transitions under way, each its element, its pseudo-element
   * ('' for the element's own), its run, a key that is its run's, and
   * none past its end: what a page's `getAnimations()` lists as a
   * `CSSTransition` each (CSS Transitions 2, 4).
   */
  cssTransitions(): {
    el: object;
    pseudo: string;
    run: Transit;
    key: number;
  }[] {
    const out: { el: object; pseudo: string; run: Transit; key: number }[] = [];
    const now = this.now;
    for (const [el, states] of this._transitions) {
      for (const [pseudo, state] of states) {
        for (const run of state.running.values()) {
          if (now >= run.start + run.duration) continue;
          out.push({ el, pseudo, run, key: transitKey(run) });
        }
      }
    }
    return out;
  }

  /** Whether an element has a transition under way, or one run out, of its
   *  own or of a pseudo-element's: its style is its own. */
  transiting(el: object): boolean {
    return this._transitions.has(el);
  }

  /** The transitions of an element's own, or of its `pseudo`'s, by the
   *  field each runs on, as of the last time it was styled — one past its
   *  end among them, where nothing has styled it since — or null where it
   *  has none under way. */
  transitsOf(
    el: object,
    pseudo = '',
  ): ReadonlyMap<string, Readonly<Transit>> | null {
    const running = this._transitions.get(el)?.get(pseudo)?.running;
    return running?.size ? running : null;
  }

  /** An element's transitions, or a pseudo-element's, are over: it is not
   *  displayed. */
  dropTransitions(el: object, pseudo: string): void {
    const states = this._transitions.get(el);
    const state = states?.get(pseudo);
    if (!states || !state) return;
    for (const run of state.running.values()) this._cancelled(el, pseudo, run);
    states.delete(pseudo);
    if (!states.size) this._transitions.delete(el);
  }

  /**
   * A transition sampled at `now`: the events its phase moving since it
   * was last sampled owes (CSS Transitions 2, 6.1) — `transitionrun` as it
   * is first seen, `transitionstart` past its delay, `transitionend` at its
   * end, each with the elapsed time the interval it crossed gives, and
   * `transitionend` or `transitionstart` again where a seek took it back.
   */
  private _seenAt(el: object, pseudo: string, run: Transit, now: number): void {
    const was = this._phases.get(run);
    const phase: TransitPhase =
      now < run.start
        ? 'before'
        : now < run.start + run.duration
          ? 'active'
          : 'after';
    if (was === phase) return;
    this._phases.set(run, phase);
    const delay = run.start - run.created;
    const begin = Math.max(Math.min(-delay, run.duration), 0);
    const end = run.duration;
    const owe = (type: CssEventRecord['type'], elapsed: number, at: number) => {
      this._cssEvents.push({
        el,
        pseudo,
        type,
        name: run.property,
        elapsed,
        key: transitKey(run),
        at,
      });
      this.onCssEvent?.();
    };
    if (was === undefined) owe('transitionrun', begin, run.created);
    const from = was === undefined ? 0 : PHASE_RANK[was];
    const to = PHASE_RANK[phase];
    if (to > from) {
      if (from < 1 && to >= 1) owe('transitionstart', begin, run.start);
      if (to === 2) owe('transitionend', end, run.start + run.duration);
    } else if (to < from) {
      // taken back by a seek
      if (from === 2 && to === 1) owe('transitionstart', end, now);
      else if (from === 2) {
        owe('transitionstart', end, now);
        owe('transitionend', begin, now);
      } else owe('transitionend', begin, now);
    }
  }

  /** A transition cancelled before its end: `transitioncancel`, with the
   *  active time it had come to (CSS Transitions 2, 6.1), where the page
   *  heard it run and has not heard it end. */
  private _cancelled(el: object, pseudo: string, run: Transit): void {
    const was = this._phases.get(run);
    if (was === undefined || was === 'after') return;
    this._phases.set(run, 'after');
    this._cssEvents.push({
      el,
      pseudo,
      type: 'transitioncancel',
      name: run.property,
      key: transitKey(run),
      at: this.now,
      elapsed: Math.max(0, Math.min(this.now - run.start, run.duration)),
    });
    this.onCssEvent?.();
  }

  /** The transitions and animations of the elements `styled` does not
   *  hold are over, cancelled: they are out of the document (CSS
   *  Transitions 1, 3; CSS Animations 1, 3). */
  endOutside(styled: ReadonlyMap<object, unknown>): void {
    for (const [el, targets] of this._targets) {
      if (styled.has(el)) continue;
      for (const [pseudo, target] of targets) {
        for (const run of target.running) {
          if (run) this._animationCancelled(el, pseudo, run);
        }
      }
      this._targets.delete(el);
    }
    for (const [el, states] of this._transitions) {
      if (styled.has(el)) continue;
      for (const [pseudo, state] of states) {
        for (const run of state.running.values()) {
          this._cancelled(el, pseudo, run);
        }
      }
      this._transitions.delete(el);
    }
  }

  /**
   * A CSS animation's run sampled at `time`, from its start: the events
   * its phase or its iteration moving since it was last sampled owes (CSS
   * Animations 1, 4.2) — `animationstart` into its active phase,
   * `animationiteration` into another iteration, `animationend` out of it
   * at its end, and the other way where it was taken back — with the
   * elapsed time the interval it crossed gives. On a scroll's timeline
   * (`scrolled`) its times are percentages of the timeline, which is a
   * hundred seconds long as a page hears it, as in Blink, and every event
   * is due now, at the frame that sampled it; at the timeline's boundary
   * (`boundary`) its end is in its active phase, as the effect's is.
   */
  private _animationAt(
    el: object,
    pseudo: string,
    run: Running,
    timing: Timing,
    time: number,
    scrolled = false,
    boundary = false,
  ): void {
    const { duration, delay, iterations } = timing;
    const active =
      duration === 0 || iterations === 0 ? 0 : duration * iterations;
    const end = Math.max(delay + active, 0);
    const beforeActive = Math.max(Math.min(delay, end), 0);
    const activeAfter = Math.max(Math.min(delay + active, end), 0);
    const phase: TransitPhase =
      time < beforeActive
        ? 'before'
        : time >= activeAfter && !(boundary && time === activeAfter)
          ? 'after'
          : 'active';
    const iteration =
      phase === 'active' && duration > 0
        ? Math.max(
            0,
            Math.min(
              Math.floor((time - delay) / duration),
              Math.ceil(iterations) - 1,
            ),
          )
        : 0;
    const scale = scrolled ? 1000 : 1;
    const was = this._runPhases.get(run);
    this._runPhases.set(run, { phase, iteration, delay, active, time, scale });
    if (was?.phase === phase && was.iteration === iteration) return;
    const begin = Math.max(Math.min(-delay, active), 0);
    const finish = Math.max(Math.min(end - delay, active), 0);
    // where on the timeline its time was nought, which places each event
    // where it was due
    const origin = this.now - time;
    const owe = (
      type: CssEventRecord['type'],
      elapsed: number,
      due: number,
    ) => {
      this._cssEvents.push({
        el,
        pseudo,
        type,
        name: run.name,
        elapsed: elapsed * scale,
        key: runKey(run),
        at: scrolled ? this.now : due,
      });
      this.onCssEvent?.();
    };
    const from = was ? PHASE_RANK[was.phase] : 0;
    const to = PHASE_RANK[phase];
    if (to > from) {
      if (from < 1) owe('animationstart', begin, origin + beforeActive);
      if (to === 2) {
        owe('animationend', finish, origin + activeAfter);
        if (this.holdsEnds && !scrolled)
          this._endsHeld.set(run, { el, pseudo });
      }
    } else if (to < from) {
      // taken back
      this._endsHeld.delete(run);
      if (from === 2) owe('animationstart', finish, this.now);
      if (to === 0) owe('animationend', begin, this.now);
    } else if (phase === 'active' && was && was.iteration !== iteration) {
      owe(
        'animationiteration',
        iteration * duration,
        origin + delay + iteration * duration,
      );
    }
  }

  /** A CSS animation's run cancelled before its end — no longer named, or
   *  its element not displayed: `animationcancel`, with the active time it
   *  had come to, where it had started and not ended (CSS Animations 2,
   *  4.2). */
  private _animationCancelled(el: object, pseudo: string, run: Running): void {
    this._endsHeld.delete(run);
    const was = this._runPhases.get(run);
    if (!was || was.phase === 'after') return;
    this._runPhases.delete(run);
    // where the clock has it now, or where the scroll last had it
    const time =
      was.scale === 1 ? (run.hold ?? this.now - run.start) : was.time;
    this._cssEvents.push({
      el,
      pseudo,
      type: 'animationcancel',
      name: run.name,
      key: runKey(run),
      at: this.now,
      elapsed: Math.max(0, Math.min(time - was.delay, was.active)) * was.scale,
    });
    this.onCssEvent?.();
  }

  /** What a transition made now is besides its timing: one that waits for
   *  the paint that first shows it, where this starts there. */
  private _made(): { pending?: boolean } {
    if (!this.startsAtPaint) return {};
    this.pendingSince = Math.min(this.pendingSince, this.now);
    return { pending: true };
  }

  /**
   * The paint that first shows the animations and transitions made since
   * the last has happened, at `now`: each that waits for it
   * (`startsAtPaint`) starts then — an animation from where it is held,
   * which is its start unless a page sought it, and a transition made then
   * with its delay to run. Whether any did.
   */
  startPending(now: number): boolean {
    let any = false;
    for (const targets of this._targets.values()) {
      for (const target of targets.values()) {
        for (const run of target.running) {
          if (!run?.pending) continue;
          run.start = now - (run.hold ?? 0);
          run.hold = null;
          run.pending = false;
          any = true;
        }
      }
    }
    for (const states of this._transitions.values()) {
      for (const state of states.values()) {
        for (const run of state.running.values()) {
          if (!run.pending) continue;
          beginAt(run, now);
          run.pending = false;
          any = true;
        }
      }
    }
    this.pendingSince = Infinity;
    return any;
  }

  /** The `animationend`s of the ends held for them (`holdsEnds`) are being
   *  told: each animation leaves its element as it would have at its end,
   *  from the next frame, which restyles it. Whether any was held. */
  releaseEnds(): boolean {
    if (!this._endsHeld.size) return false;
    for (const { el, pseudo } of this._endsHeld.values()) {
      const target = this._targets.get(el)?.get(pseudo);
      if (target) target.next = 0;
    }
    this._endsHeld.clear();
    return true;
  }

  /** The transition events owed since this was last asked, in order. */
  takeCssEvents(): CssEventRecord[] {
    const out = this._cssEvents;
    this._cssEvents = [];
    return out;
  }

  /**
   * A page set where a CSS animation's time is (`CSSAnimation`'s
   * `currentTime`): its run is held there where it is paused, and runs
   * from there where it plays, restyled at the next frame. The element it
   * is on, or null where no run under way has the key.
   */
  seekAnimation(
    key: number,
    currentTime: number,
    paused = false,
  ): object | null {
    for (const [el, targets] of this._targets) {
      for (const target of targets.values()) {
        for (const run of target.running) {
          if (!run || RUN_KEYS.get(run) !== key) continue;
          // played again after a cancel, it starts over from there
          run.pageCancelled = false;
          run.pagePaused = paused;
          if (paused || run.hold !== null) run.hold = currentTime;
          else run.start = this.now - (run.trig?.rate ?? 1) * currentTime;
          target.next = 0;
          return el;
        }
      }
    }
    return null;
  }

  /**
   * A page did something to a CSS animation on a scroll's timeline
   * (`CSSAnimation`, a seek, `pause()`, `play()`, `playbackRate`): it is
   * held at `time` where `mode` is `hold` — at where its timeline has it,
   * the next time it is sampled, for null — runs from the start time
   * `time` for `start`, and is aligned to its range again for `align`, at
   * `rate` (`ScrollRun`), and is restyled at the next frame. The element
   * it is on, or null where no run under way has the key.
   */
  seekScrolled(
    key: number,
    mode: 'align' | 'start' | 'hold',
    time: number | null,
    rate: number,
  ): object | null {
    for (const [el, targets] of this._targets) {
      for (const target of targets.values()) {
        for (const run of target.running) {
          if (!run || RUN_KEYS.get(run) !== key) continue;
          this._sought.add(el);
          run.pageCancelled = false;
          run.pagePaused = mode === 'hold';
          run.scroll = {
            hold: mode === 'hold' ? time : null,
            start: mode === 'start' ? time : null,
            rate: Number.isFinite(rate) ? rate : 1,
            at: run.scroll?.at ?? null,
          };
          target.next = 0;
          return el;
        }
      }
    }
    return null;
  }

  /** A page cancelled a CSS animation (`CSSAnimation.cancel()`):
   *  `animationcancel`, and it draws nothing until the style names it
   *  again. The element it is on, or null. */
  cancelAnimation(key: number): object | null {
    for (const [el, targets] of this._targets) {
      for (const [pseudo, target] of targets) {
        for (const run of target.running) {
          if (!run || RUN_KEYS.get(run) !== key) continue;
          this._animationCancelled(el, pseudo, run);
          this._sought.add(el);
          run.pageCancelled = true;
          target.next = 0;
          return el;
        }
      }
    }
    return null;
  }

  /** A page cancelled a CSS transition (`CSSTransition.cancel()`):
   *  `transitioncancel`, and the property is at its end value. The element
   *  it is on, or null. */
  cancelTransition(key: number): object | null {
    for (const [el, states] of this._transitions) {
      for (const [pseudo, state] of states) {
        for (const [field, run] of state.running) {
          if (TRANSIT_KEYS.get(run) !== key) continue;
          this._cancelled(el, pseudo, run);
          state.running.delete(field);
          state.completed.set(field, run.to);
          state.next = 0;
          return el;
        }
      }
    }
    return null;
  }

  /** Whether an element has a CSS animation on the clock, of its own or
   *  of a pseudo-element's, rather than on a scroll's timeline. */
  animatesOnClock(el: object): boolean {
    const targets = this._targets.get(el);
    if (!targets) return false;
    for (const target of targets.values()) if (target.clocked) return true;
    return false;
  }

  /**
   * A page set where a transition's time is (`CSSTransition.currentTime`):
   * it is made again, its key, phase and everything else kept, as made
   * `currentTime` ago, and is restyled at the next frame. The element it
   * is on, or null where no transition under way has the key.
   */
  seekTransition(key: number, currentTime: number): object | null {
    for (const [el, states] of this._transitions) {
      for (const state of states.values()) {
        for (const [field, run] of state.running) {
          if (TRANSIT_KEYS.get(run) !== key) continue;
          const created = this.now - currentTime;
          const moved: Transit = {
            ...run,
            created,
            start: created + (run.start - run.created),
            pending: false,
          };
          TRANSIT_KEYS.set(moved, key);
          const phase = this._phases.get(run);
          if (phase) this._phases.set(moved, phase);
          state.running.set(field, moved);
          state.next = 0;
          return el;
        }
      }
    }
    return null;
  }
}

/** Whether two `animation-timeline` entries name one timeline, as two
 *  styles computed apart hold it. */
function sameRef(a: TimelineRef, b: TimelineRef): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A `@keyframes` with its frames at timeline offsets placed in the
 * iteration, where `place` puts each — outside 0 to 1 where it is outside
 * the animation's range — and the rule as it is where it has none. Kept by
 * the rule and where its frames came to, so a timeline that has not moved
 * finds the rule it made, and the tracks made of it.
 */
function placedRule(
  rule: KeyframesRule,
  place: (range: { name: string; pct: number }) => number,
): KeyframesRule {
  if (!rule.frames.some((f) => f.ranges)) return rule;
  const placed = rule.frames.map((f) =>
    f.ranges ? [...f.offsets, ...f.ranges.map(place)] : f.offsets,
  );
  const key = placed.map((o) => o.join(',')).join(';');
  const kept = PLACED.get(rule);
  if (kept?.key === key) return kept.rule;
  const out: KeyframesRule = {
    ...rule,
    frames: rule.frames.map((f, i) =>
      f.ranges ? { ...f, offsets: placed[i] } : f,
    ),
  };
  PLACED.set(rule, { key, rule: out });
  return out;
}

const PLACED = new WeakMap<
  KeyframesRule,
  { key: string; rule: KeyframesRule }
>();

/** Whether a `@keyframes` sets a property that is inherited — a custom
 *  property is — so that what the element holds changes with it. */
export function animatesInherited(rule: KeyframesRule): boolean {
  let inherits = INHERITS.get(rule);
  if (inherits === undefined) {
    inherits = false;
    for (const prop of tracksOf(rule).keys()) {
      if (prop.startsWith('--') || isInherited(prop)) {
        inherits = true;
        break;
      }
    }
    INHERITS.set(rule, inherits);
  }
  return inherits;
}

const INHERITS = new WeakMap<KeyframesRule, boolean>();

/** A property's transition under way (CSS Transitions 1, 3), on one field
 *  of the computed style. Never changed once made: a change to one under
 *  way makes another. */
export interface Transit {
  /** Which it is, the same in a fork: no other transition has it. */
  serial: number;
  /** The longhand it is of, as a `CSSTransition` names it. */
  property: string;
  /** When it was made, on the timeline: its delay runs from here. */
  created: number;
  /** When it starts, its delay out, on the timeline. */
  start: number;
  /** From its start to its end, in milliseconds. */
  duration: number;
  easing: Easing;
  from: unknown;
  to: unknown;
  /** Its reversing-adjusted start value: where one that turns back the way
   *  it came is going. */
  back: unknown;
  /** Its reversing shortening factor: how much of a whole one that turned
   *  back runs. */
  shortening: number;
  /** Whether it is new and waits for the paint that first shows it
   *  (`AnimationTimeline.startsAtPaint`): until then it has just begun,
   *  wherever the clock is (`beginAt`). */
  pending?: boolean;
}

let transitSeq = 0;

/** Where a transition is (Web Animations 1, 4.5.10, an effect's phase):
 *  in its delay, under way, or at its end. */
type TransitPhase = 'before' | 'active' | 'after';

const PHASE_RANK: Record<TransitPhase, number> = {
  before: 0,
  active: 1,
  after: 2,
};

/** A CSS transition event owed the page (CSS Transitions 2, 6.1): its
 *  element and pseudo-element, its type, the longhand and the elapsed
 *  time, in milliseconds. */
export interface CssEventRecord {
  el: object;
  pseudo: string;
  type:
    | 'transitionrun'
    | 'transitionstart'
    | 'transitionend'
    | 'transitioncancel'
    | 'animationstart'
    | 'animationiteration'
    | 'animationend'
    | 'animationcancel';
  /** The longhand a transition is of, or an animation's name. */
  name: string;
  elapsed: number;
  /** Its run's key, which `getAnimations()` knows its object by. */
  key: number;
  /** When on the timeline it was due, which orders the events of a frame
   *  (Web Animations 1, 4.4.18, "update animations and send events"). */
  at: number;
}

/** An element's transitions, or a pseudo-element's, by field. */
interface Transiting {
  running: Map<string, Transit>;
  /** The end of each that ran out, while the style is still at it. */
  completed: Map<string, unknown>;
  /** When it next changes: a frame from now while one runs, the end of a
   *  delay before one starts, never where none runs. */
  next: number;
  /** Whether one runs on an inherited property, which reaches what the
   *  element holds. */
  inherits: boolean;
}

const INHERITED_FIELDS = new Set<string>(INHERITED);

/** The clock of an element's script animations, or a pseudo-element's. */
interface ScriptTarget {
  /** When they next change: a frame from now while one is under way, the
   *  end of a delay before one starts, never where each holds — and 0,
   *  the next frame, where a script changed one. */
  next: number;
  /** Whether one sets an inherited property. */
  inherits: boolean;
}

/** A list's entry for a transition at `index`, the list repeated to the
 *  length of `transition-property` (CSS Transitions 1, 2). */
function item<T>(list: readonly T[], index: number): T {
  return list[index % list.length];
}

/**
 * The fields a style's transitions run on, each with the index of the
 * transition in its lists: those of each property `transition-property`
 * names, every one for `all` (`transitionableFields`), the last naming of
 * a property winning (CSS Transitions 1, 2.1). A field whose transition
 * has no length — no duration and a delay that is none or negative — is
 * none. Kept by the list.
 */
function transitionFields(list: Transitions): ReadonlyMap<string, number> {
  let fields = TRANSITION_FIELDS.get(list);
  if (fields) return fields;
  // and by what the lists say, for the longhands each element's cascade
  // puts together again
  const key = `${list.properties.join(',')}|${list.durations.join(',')}|${list.delays.join(',')}`;
  fields = FIELDS_BY_KEY.get(key);
  if (fields) {
    TRANSITION_FIELDS.set(list, fields);
    return fields;
  }
  const out = new Map<string, number>();
  list.properties.forEach((name, index) => {
    const length =
      Math.max(0, item(list.durations, index)) + item(list.delays, index);
    const names =
      name === 'all' ? transitionableFields() : (animatedFields(name) ?? []);
    for (const field of names) {
      if (length > 0) out.set(field, index);
      else out.delete(field);
    }
  });
  TRANSITION_FIELDS.set(list, out);
  if (FIELDS_BY_KEY.size >= 256) FIELDS_BY_KEY.clear();
  FIELDS_BY_KEY.set(key, out);
  return out;
}

const TRANSITION_FIELDS = new WeakMap<Transitions, Map<string, number>>();
const FIELDS_BY_KEY = new Map<string, Map<string, number>>();

/** A transition's value at `t`: where it starts through its delay — a
 *  transition fills backwards (CSS Transitions 1, 3) — and eased between
 *  its two ends after. */
function transitValue(field: string, run: Transit, t: number): unknown {
  if (t < run.start) return run.from;
  const p = run.duration > 0 ? (t - run.start) / run.duration : 1;
  if (p >= 1) return run.to;
  const q = ease(run.easing, p);
  return (
    interpolateField(field, run.from, run.to, q) ??
    discreteField(field, run.from, run.to, q)
  );
}

/**
 * What the properties a `@keyframes` sets make of the element it runs on,
 * as `will-change` naming them would: for every property an animation
 * that is current or in effect targets, the element acts as though
 * `will-change` named it (Web Animations 1, 5.6) — so an animation of
 * `opacity` makes a stacking context for as long as it runs, the frames at
 * an opacity of 1 among them, and one of `transform` a containing block as
 * well, from before its delay ends to after its end where it fills
 * forwards. Kept by the rule.
 */
export function animatedWillChange(rule: KeyframesRule): number {
  let bits = WILL_CHANGES.get(rule);
  if (bits === undefined) {
    bits = 0;
    for (const prop of tracksOf(rule).keys()) bits |= willChangeOf(prop);
    WILL_CHANGES.set(rule, bits);
  }
  return bits;
}

const WILL_CHANGES = new WeakMap<KeyframesRule, number>();

/** The fields of the computed style the properties a `@keyframes` sets
 *  decide. Kept by the rule. */
function fieldsOf(rule: KeyframesRule): ReadonlySet<string> {
  let fields = FIELDS_OF.get(rule);
  if (!fields) {
    const out = new Set<string>();
    for (const prop of tracksOf(rule).keys()) {
      for (const field of animatedFields(prop) ?? []) out.add(field);
    }
    FIELDS_OF.set(rule, (fields = out));
  }
  return fields;
}

const FIELDS_OF = new WeakMap<KeyframesRule, ReadonlySet<string>>();

/** The fields the animations `samples` are of set — each with an effect at
 *  the timeline's time — or null where there are none. */
export function fieldsAnimatedBy(
  samples: readonly Sample[] | null,
): ReadonlySet<string> | null {
  if (!samples?.length) return null;
  if (samples.length === 1) return fieldsOf(samples[0].rule);
  const out = new Set<string>();
  for (const { rule } of samples) for (const f of fieldsOf(rule)) out.add(f);
  return out;
}

/** The fields of a computed style its animations set, by the style: what a
 *  transition, comparing it as the style before a change, takes for no
 *  change of the element's (`AnimationTimeline.transition`). */
const ANIMATED_FIELDS = new WeakMap<ComputedStyle, ReadonlySet<string>>();

/** That `style` is one in which its animations set `fields`. */
export function noteAnimated(
  style: ComputedStyle,
  fields: ReadonlySet<string>,
): void {
  ANIMATED_FIELDS.set(style, fields);
}

/**
 * A CSS animation's timing on a scroll's timeline (Web Animations 2, 4.2,
 * "convert a time-based animation to a proportional animation"): every
 * time a percentage of the timeline, an `auto` duration — 0 — and no delay
 * filling it.
 */
function proportional(timing: ReturnType<typeof timingAt>, span = 100) {
  const { duration, delay, iterations } = timing;
  if (duration === 0 && delay === 0) {
    return {
      ...timing,
      duration:
        iterations > 0 && iterations !== Infinity ? span / iterations : 0,
    };
  }
  const total = Math.max(
    delay + (duration === 0 || iterations === 0 ? 0 : duration * iterations),
    0,
  );
  if (!(total > 0) || total === Infinity) {
    return { ...timing, delay: 0, duration: 0 };
  }
  const k = span / total;
  return { ...timing, delay: delay * k, duration: duration * k };
}

/** A timing as it is drawn while its end waits to be told (`holdsEnds`):
 *  filling forwards, whatever it fills. */
function filledForwards(timing: Timing): Timing {
  if (timing.fill === 'forwards' || timing.fill === 'both') return timing;
  return { ...timing, fill: timing.fill === 'backwards' ? 'both' : 'forwards' };
}

/** A transition begun at `at`: made then, and started its delay after. */
function beginAt(run: Transit, at: number): void {
  run.start = at + (run.start - run.created);
  run.created = at;
}
