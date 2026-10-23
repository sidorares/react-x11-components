// A view transition as `<Html>` draws it (CSS View Transitions 1): what it
// captured of the old state, the elements of the new, and the timeline the
// pseudo-elements it draws them in animate on. The page's realm runs the
// transition's steps (`scripts/dom.ts`), and asks the element to capture
// each state and to end it; the element builds the tree of pseudo-elements
// as boxes in its top layer (`TransitionTree`) and paints each image.

import type { Element } from 'domhandler';
import { AnimationTimeline } from './css/timeline.js';
import { timingAt } from './css/animation.js';
import type { ComputedStyle } from './css/style.js';
import type { Declaration, KeyframesRule } from './css/parse.js';
import type { Matrix } from './css/transform.js';
import type { SurfaceLike } from './surfaces.js';

/**
 * Where an element is, as a transition captures it (7.4): its border box's
 * size and the matrix from its corner to the viewport's, both in device
 * pixels, and what of its style its group takes (7.8).
 */
export interface Placement {
  width: number;
  height: number;
  matrix: Matrix;
  direction: string;
  mixBlendMode: string;
}

/** An element as the old state had it: where it was, and a picture of it
 *  and all it held, with what it drew past its border box (`ink…`, from
 *  the border box's corner). */
export interface OldImage extends Placement {
  surface: SurfaceLike | null;
  inkX: number;
  inkY: number;
  inkWidth: number;
  inkHeight: number;
}

/** One name of a transition's: its element's image in the old state, and
 *  its element in the new, where each has one. */
export interface TransitionEntry {
  name: string;
  classes: readonly string[];
  old: OldImage | null;
  el: Element | null;
  /** Where the new element was the last time it was laid out. */
  now: Placement | null;
  /** The `@keyframes` its group runs from where its element was, where it
   *  has both (`ViewTransitionRun.keyframes`). */
  anim: string | null;
}

export class ViewTransitionRun {
  /** Its old state captured and its update not yet done, or its tree
   *  drawn. */
  phase: 'old' | 'live' = 'old';
  /** Its names, in the order its groups are drawn: the old state's in
   *  their elements' paint order, the root's first, and then the new
   *  state's the old had not. */
  readonly entries = new Map<string, TransitionEntry>();
  /** What its pseudo-elements animate on: a clock of its own, which the
   *  document's frames do not run. */
  readonly timeline = new AnimationTimeline();
  /** The `@keyframes` it makes for its groups (`Cascade.transitionKeyframes`). */
  readonly keyframes = new Map<string, KeyframesRule>();
  /** How each of its pseudo-elements was last styled, by its key: what
   *  its style under its animations is worked out from again. */
  readonly styled = new Map<
    string,
    {
      part: 'view-transition' | 'group' | 'image-pair' | 'old' | 'new';
      name: string;
      classes: readonly string[];
      onlyChild: boolean;
      parent: ComputedStyle;
      dynamic: readonly Declaration[];
    }
  >();
  /** When its tree was first drawn, on the clock, which its animations
   *  start from. */
  started = 0;
  /** When its pseudo-elements' animations are all over, on the clock:
   *  `Infinity` while one is paused or never ends. */
  endsAt = 0;

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.old?.surface?.destroy?.();
    }
  }
}

/** The name each element captured by `auto` or `match-element` takes, by
 *  its identity (CSS View Transitions 2, 3.1). */
const ELEMENT_NAMES = new WeakMap<object, string>();
let elementNames = 0;

/**
 * The name an element is captured by (CSS View Transitions 1, 3.5; 2, 3.1),
 * or null for none: its `view-transition-name`, its `id` for `auto` where
 * it has one, and a name its identity makes for `match-element` and for
 * `auto` without one — which a rule reaches by its classes or by `*` alone.
 */
export function captureName(el: Element, style: ComputedStyle): string | null {
  const name = style.viewTransitionName;
  if (name === 'none') return null;
  if (name === 'auto' || name === 'match-element') {
    const id = el.attribs.id;
    if (name === 'auto' && id) return id;
    let made = ELEMENT_NAMES.get(el);
    if (!made) {
      made = `-ua-element-${++elementNames}`;
      ELEMENT_NAMES.set(el, made);
    }
    return made;
  }
  return name;
}

/** The classes an element is captured with (CSS View Transitions 2, 3.2). */
export function captureClasses(style: ComputedStyle): string[] {
  const classes = style.viewTransitionClass;
  return classes === 'none' ? [] : classes.split(' ');
}

/**
 * How long a pseudo-element's animations run, in milliseconds from when
 * they started: the longest of their delays and active durations, and
 * `Infinity` where one is paused or runs for ever — a transition is over
 * only once all of them are (CSS View Transitions 1, 7.9).
 */
export function animationsEnd(style: ComputedStyle): number {
  const lists = style.animations;
  let end = 0;
  lists.names.forEach((name, i) => {
    if (name === null) return;
    if (lists.playStates[i % lists.playStates.length] === 'paused') {
      end = Infinity;
      return;
    }
    const t = timingAt(lists, i);
    end = Math.max(end, t.delay + t.duration * t.iterations);
  });
  return end;
}

/**
 * A group's `transform`, in CSS pixels: the matrix that puts its element's
 * border box where it is from the viewport's corner, taken about the
 * group's centre — the origin the group's transform is applied about — so
 * that, applied there, it does what `m` does from the corner.
 */
export function groupTransform(
  m: Matrix,
  width: number,
  height: number,
  scale: number,
): string {
  const [a, b, c, d, e, f] = m;
  const cx = width / 2;
  const cy = height / 2;
  // T(-c) · m · T(c)
  const x = a * cx + c * cy + e - cx;
  const y = b * cx + d * cy + f - cy;
  const n = (v: number) => String(Math.round(v * 1e6) / 1e6);
  return `matrix(${[a, b, c, d, x / scale, y / scale].map(n).join(', ')})`;
}

/** A name as CSS writes it in an identifier (CSSOM 2.1, "serialize an
 *  identifier"): what is no letter of one escaped, so that it reads back
 *  as the name. */
export function cssIdent(name: string): string {
  let out = '';
  const first = name.codePointAt(0);
  for (let i = 0; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    const ch = name[i];
    if (c === 0) out += '\uFFFD';
    else if (
      (c >= 0x1 && c <= 0x1f) ||
      c === 0x7f ||
      (i === 0 && c >= 0x30 && c <= 0x39) ||
      (i === 1 && c >= 0x30 && c <= 0x39 && first === 0x2d)
    ) {
      out += `\\${c.toString(16)} `;
    } else if (i === 0 && c === 0x2d && name.length === 1) {
      out += '\\-';
    } else if (
      c >= 0x80 ||
      c === 0x2d ||
      c === 0x5f ||
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a)
    ) {
      out += ch;
    } else {
      out += `\\${ch}`;
    }
  }
  return out;
}
