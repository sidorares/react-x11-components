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
import type { Animations, Easing, Transitions } from './animation.js';
import {
  discreteField,
  interpolateField,
  keywordSizes,
  same,
} from './interpolate.js';
import type { KeyframesRule } from './parse.js';
import type { AnimationAction, AnimationTrigger } from './triggers.js';
import type { ScriptSampling } from './scripted.js';
import {
  INHERITED,
  animatedFields,
  copyStyle,
  isInherited,
  transitionableFields,
  willChangeOf,
} from './style.js';
import type { ComputedStyle, TimelineRef } from './style.js';

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
}

interface Target {
  /** By the element's `animation-name` list, null where an entry is
   *  `none`. */
  running: (Running | null)[];
  /** The scroll-driven timelines its animations run on, and where each
   *  was when it was last sampled: what a scroll or a layout compares
   *  (`restyleScrolled`). */
  scrolled?: { refs: TimelineRef[]; at: (number | null)[] };
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
          if (!transits.has(state)) states.delete(pseudo);
        }
        if (!states.size) this._transitions.delete(el);
      }
    }
    if (!seen) return;
    for (const [el, targets] of this._targets) {
      for (const [pseudo, target] of targets) {
        if (!seen.has(target)) targets.delete(pseudo);
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
    const { names, easings, playStates, triggers } = animations;
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (name === null) {
        running.push(null);
        continue;
      }
      let run = was.find((r) => r !== null && r.name === name && !taken.has(r));
      if (!run) run = { name, start: now, hold: null };
      taken.add(run);
      running.push(run);
      // one on a scroll's timeline, or on none, is where the scroll has
      // it, and its clock is no part of it
      const ref = timelines.length ? timelines[i % timelines.length] : null;
      if (ref && ref.kind !== 'auto') {
        const p =
          ref.kind === 'none'
            ? null
            : (this.scrollProgress?.(el, pseudo, ref) ?? null);
        if (ref.kind !== 'none') {
          scrolled ??= { refs: [], at: [] };
          scrolled.refs.push(ref);
          scrolled.at.push(p?.at ?? null);
        }
        const rule = keyframesOf(name);
        if (!rule || !p) continue;
        if (!inherits) inherits = animatesInherited(rule);
        const timing = proportional(timingAt(animations, i));
        const active =
          timing.duration === 0 || timing.iterations === 0
            ? 0
            : timing.duration * timing.iterations;
        const end = Math.max(timing.delay + active, 0);
        const activeAfter = Math.max(Math.min(timing.delay + active, end), 0);
        // at its scroller's end, the end of the active phase is in it:
        // it holds its end there as one that fills forwards would
        const boundary =
          p.edge && activeAfter > 0 && Math.abs(p.at - activeAfter) < 1e-9;
        const fill =
          boundary && (timing.fill === 'none' || timing.fill === 'backwards')
            ? timing.fill === 'none'
              ? 'forwards'
              : 'both'
            : timing.fill;
        const at = progressAt({ ...timing, fill }, p.at);
        if (at.phase !== 'after' || at.progress !== null) {
          willChange |= animatedWillChange(rule);
        }
        if (at.progress === null) continue;
        (out ??= []).push({
          rule,
          progress: at.progress,
          easing: easings[i % easings.length],
          duration: timing.duration,
          forwards: at.forwards,
          // it moves as the scroll does, which asks for its frames
          left: 0,
        });
        continue;
      }
      const timing = timingAt(animations, i);
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
        (!!trig && trig.state !== 'playing');
      if (paused && run.hold === null) {
        run.hold = rate * (now - run.start);
      } else if (!paused && run.hold !== null) {
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
      const at = progressAt(timing, time);
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
          // backwards through its delay, it finishes at its start
          timed = Math.min(
            timed,
            rate > 0 ? run.start + timing.delay : run.start,
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
    };
    targets.set(pseudo, target);
    this._seen?.add(target);
    return out;
  }

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
          const at = progress(el, pseudo, ref)?.at ?? null;
          return at !== scrolled.at[i];
        });
        if (moved) {
          target.next = 0;
          any = true;
        }
      }
    }
    return any;
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
    if (!targets?.delete(pseudo)) return;
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
        serial: ++transitSeq,
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
          serial: ++transitSeq,
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
          serial: ++transitSeq,
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
    if (!states?.delete(pseudo)) return;
    if (!states.size) this._transitions.delete(el);
  }
}

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
}

let transitSeq = 0;

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
function proportional(timing: ReturnType<typeof timingAt>) {
  const { duration, delay, iterations } = timing;
  if (duration === 0 && delay === 0) {
    return {
      ...timing,
      duration:
        iterations > 0 && iterations !== Infinity ? 100 / iterations : 0,
    };
  }
  const total = Math.max(
    delay + (duration === 0 || iterations === 0 ? 0 : duration * iterations),
    0,
  );
  if (!(total > 0) || total === Infinity) {
    return { ...timing, delay: 0, duration: 0 };
  }
  const k = 100 / total;
  return { ...timing, delay: delay * k, duration: duration * k };
}
