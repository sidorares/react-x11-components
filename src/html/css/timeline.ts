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

import { progressAt, timingAt, tracksOf } from './animation.js';
import type { Animations, Easing } from './animation.js';
import type { KeyframesRule } from './parse.js';
import { isInherited } from './style.js';

/** How long a frame is: what an animation under way waits for its next. */
export const FRAME_MS = 16;

/** An animation at a time: the frames it runs, how far through them its
 *  iteration is — 0 at `from`, 1 at `to` — and its timing function, which
 *  eases each span between two frames. */
export interface Sample {
  rule: KeyframesRule;
  progress: number;
  easing: Easing;
}

export interface Running {
  name: string;
  /** When it started, on the timeline. */
  start: number;
  /** The time it is held at while paused, from its start; null while it
   *  plays. */
  hold: number | null;
}

interface Target {
  /** By the element's `animation-name` list, null where an entry is
   *  `none`. */
  running: (Running | null)[];
  /** When it next changes: a frame from now while one is under way, the
   *  end of a delay before one starts, and never once each is over or
   *  paused. */
  next: number;
  /** Whether a property it animates is inherited, which reaches what the
   *  element holds. */
  inherits: boolean;
}

export class AnimationTimeline {
  /** The time the styles are computed at: the clock's, set before each
   *  pass that computes any. */
  now = 0;
  private _targets = new Map<object, Map<string, Target>>();
  /** The targets a pass that styles the whole document has styled. */
  private _seen: Set<Target> | null = null;

  /** A pass begins: where `whole`, it styles every element displayed, and
   *  ends every animation it does not reach (`endPass`). */
  beginPass(whole: boolean): void {
    this._seen = whole ? new Set() : null;
  }

  endPass(): void {
    const seen = this._seen;
    this._seen = null;
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
  ): Sample[] | null {
    let targets = this._targets.get(el);
    const was = targets?.get(pseudo)?.running ?? [];
    const taken = new Set<Running>();
    const running: (Running | null)[] = [];
    const now = this.now;
    let next = Infinity;
    let inherits = false;
    let out: Sample[] | null = null;
    const { names, easings, playStates } = animations;
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
      const paused = playStates[i % playStates.length] === 'paused';
      if (paused && run.hold === null) {
        run.hold = now - run.start;
      } else if (!paused && run.hold !== null) {
        run.start = now - run.hold;
        run.hold = null;
      }
      const rule = keyframesOf(name);
      if (!rule) continue;
      if (!inherits) inherits = animatesInherited(rule);
      const timing = timingAt(animations, i);
      const { progress, phase } = progressAt(
        timing,
        run.hold ?? now - run.start,
      );
      if (!paused) {
        if (phase === 'active') next = Math.min(next, now + FRAME_MS);
        else if (phase === 'before') {
          next = Math.min(next, run.start + timing.delay);
        }
      }
      if (progress === null) continue;
      (out ??= []).push({
        rule,
        progress,
        easing: easings[i % easings.length],
      });
    }
    if (!taken.size) {
      this.drop(el, pseudo);
      return null;
    }
    if (!targets) this._targets.set(el, (targets = new Map()));
    const target: Target = { running, next, inherits };
    targets.set(pseudo, target);
    this._seen?.add(target);
    return out;
  }

  /** An element's animations, or a pseudo-element's, are over: its lists
   *  name none. */
  drop(el: object, pseudo: string): void {
    const targets = this._targets.get(el);
    if (!targets?.delete(pseudo)) return;
    if (!targets.size) this._targets.delete(el);
  }

  /** The runs of an element's own animations, by its `animation-name`
   *  list as it was last styled — when each started, and the time a paused
   *  one holds — or null where it has none. */
  runsOf(el: object): readonly (Readonly<Running> | null)[] | null {
    return this._targets.get(el)?.get('')?.running ?? null;
  }

  /**
   * A timeline holding one element's own animations as this one has them:
   * what its style at another time is computed against, `now` set to that
   * time, leaving this one as it was. A sprite's frames are sampled so
   * (`src/html/sprites.ts`).
   */
  fork(el: object): AnimationTimeline {
    const fork = new AnimationTimeline();
    fork.now = this.now;
    const target = this._targets.get(el)?.get('');
    if (target) {
      const running = target.running.map((run) => run && { ...run });
      fork._targets.set(el, new Map([['', { ...target, running }]]));
    }
    return fork;
  }

  /** Whether the timeline knows of no animation at all. */
  get empty(): boolean {
    return this._targets.size === 0;
  }

  /** Whether an animation of an element's, or of a pseudo-element of its,
   *  changes as time passes. */
  isLive(el: object): boolean {
    const targets = this._targets.get(el);
    if (!targets) return false;
    for (const target of targets.values()) {
      if (target.next !== Infinity) return true;
    }
    return false;
  }

  /** The elements with an animation that changes as time passes, and for
   *  each whether what it holds inherits what changes, and whether it is
   *  one of a pseudo-element's — but those `skip` says the frames of are
   *  not this timeline's to run: one whose animation the render server
   *  runs on a layer of its own. */
  live(
    skip: ((el: object) => boolean) | null = null,
  ): { el: object; inherits: boolean; generated: boolean }[] {
    const out: { el: object; inherits: boolean; generated: boolean }[] = [];
    for (const [el, targets] of this._targets) {
      if (skip?.(el)) continue;
      let live = false;
      let inherits = false;
      let generated = false;
      for (const [pseudo, target] of targets) {
        if (target.next === Infinity) continue;
        live = true;
        inherits ||= target.inherits;
        generated ||= pseudo !== '';
      }
      if (live) out.push({ el, inherits, generated });
    }
    return out;
  }

  /** When an animation next changes, on the timeline; null where none
   *  will without a style change. One `skip` names is not counted
   *  (`live`). */
  nextFrame(skip: ((el: object) => boolean) | null = null): number | null {
    let next = Infinity;
    for (const [el, targets] of this._targets) {
      if (skip?.(el)) continue;
      for (const target of targets.values()) {
        if (target.next < next) next = target.next;
      }
    }
    return next === Infinity ? null : next;
  }
}

/** Whether a `@keyframes` sets a property that is inherited — a custom
 *  property is — so that what the element holds changes with it. */
function animatesInherited(rule: KeyframesRule): boolean {
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
