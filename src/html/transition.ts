// A view transition as `<Html>` draws it (CSS View Transitions 1): what it
// captured of the old state, the elements of the new, and the timeline the
// pseudo-elements it draws them in animate on. The page's realm runs the
// transition's steps (`scripts/dom.ts`), and asks the element to capture
// each state and to end it; the element builds the tree of pseudo-elements
// as boxes in its top layer (`TransitionTree`) and paints each image.

import type { Element } from 'domhandler';
import { shadowRootAround } from './dom.js';
import { AnimationTimeline } from './css/timeline.js';
import { readIdent } from './css/parse.js';
import { timingAt } from './css/animation.js';
import type { ComputedStyle } from './css/style.js';
import type { Declaration, KeyframesRule } from './css/parse.js';
import { invert, multiply } from './css/transform.js';
import type { Matrix } from './css/transform.js';
import type { SurfaceLike } from './surfaces.js';

/**
 * Where an element is, as a transition captures it (7.4): its border box's
 * size and the matrix from its corner to the viewport's, both in device
 * pixels, and what of its style its group takes (7.8) — writing mode,
 * direction, text orientation, mix-blend-mode and color-scheme, so the
 * group's `inline-size` / `block-size` and the images' logical insets
 * follow the element (WPT `*-root-vertical-writing-mode`,
 * `massive-element-*-of-viewport-*` under `vertical-lr`).
 */
export interface Placement {
  width: number;
  height: number;
  matrix: Matrix;
  direction: string;
  writingMode: string;
  textOrientation: string;
  mixBlendMode: string;
  /** The element's `color-scheme` as written (`colorSchemeKeywords`). */
  colorScheme: string;
  /** Its used border widths, top, right, bottom and left, in device
   *  pixels: what a group nested in its group is placed inside, and its
   *  `::view-transition-group-children()`'s border (CSS View Transitions 2,
   *  3.3). */
  borders: readonly [number, number, number, number];
  /** Its `border-radius` and `corner-shape`, computed, as declarations:
   *  what its `::view-transition-group-children()` is shaped by. */
  corners: string;
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
  /** The name whose group its group nests in, as each state found it (CSS
   *  View Transitions 2, 12.5.4.3), or null for the tree's root. */
  oldParent: string | null;
  newParent: string | null;
  /** The `@keyframes` its group-children runs from its element's old
   *  border and corners, where it holds a group and has both. */
  childrenAnim: string | null;
}

/** The name whose group an entry's group nests in: the new state's where it
 *  has one, as the new capture sets it over the old's (12.5.4.4–5). */
export function parentOf(entry: TransitionEntry): string | null {
  return entry.el ? entry.newParent : entry.oldParent;
}

/**
 * A group's matrix made relative to the group it nests in (CSS View
 * Transitions 2, 12.5.4.7): from the corner of the container's
 * `::view-transition-group-children()`'s padding box — the container's
 * border box, moved in by its border's left and top — where it was from the
 * viewport's.
 */
export function nestedMatrix(m: Matrix, container: Placement): Matrix | null {
  const [, , , l] = container.borders;
  const [top] = container.borders;
  const inner = multiply(container.matrix, [1, 0, 0, 1, l, top]);
  const back = invert(inner);
  return back ? multiply(back, m) : null;
}

/**
 * The name whose group each captured element's group nests in (CSS View
 * Transitions 2, 12.5.4.2–3), by the flat tree: what its
 * `view-transition-group` asks of the participating elements around it —
 * the nearest whose own is not `normal` for `normal` and `contain`, the
 * nearest of all for `nearest`, the one of that name for a name where one
 * is around it, and none for `none`, as Chromium takes it.
 */
export function containingGroups(
  named: readonly { name: string; el: Element; group: string }[],
  parentOf: (el: Element) => Element | null,
): Map<string, string | null> {
  const by = new Map<Element, { name: string; group: string }>();
  for (const n of named) by.set(n.el, n);
  const out = new Map<string, string | null>();
  for (const { name, el, group } of named) {
    let nearest: string | null = null;
    let containing: string | null = null;
    let named: string | null = null;
    for (let at = parentOf(el); at; at = parentOf(at)) {
      const p = by.get(at);
      if (!p) continue;
      nearest ??= p.name;
      if (containing === null && p.group !== 'normal' && p.group !== 'none') {
        containing = p.name;
      }
      if (named === null && p.name === group) named = p.name;
    }
    out.set(
      name,
      group === 'none'
        ? null
        : group === 'nearest'
          ? nearest
          : group === 'normal' || group === 'contain'
            ? containing
            : (named ?? containing),
    );
  }
  return out;
}

export class ViewTransitionRun {
  /** The element it was started on (CSS View Transitions 2, 2.2), whose
   *  subtree its names are found in and whose box its tree is hung in; null
   *  for the document's, whose tree is in the top layer. */
  readonly scope: Element | null;
  constructor(scope: Element | null = null) {
    this.scope = scope;
  }
  /** Its old state captured and its update not yet done, or its tree
   *  drawn. */
  phase: 'old' | 'live' = 'old';
  /** The timer for its tree's next frame. */
  timer: unknown = null;
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
      part:
        | 'view-transition'
        | 'group'
        | 'group-children'
        | 'image-pair'
        | 'old'
        | 'new';
      name: string;
      classes: readonly string[];
      onlyChild: boolean;
      parent: ComputedStyle;
      dynamic: readonly Declaration[];
    }
  >();
  /** The document in the viewport as its old state was captured, all of
   *  it: what is drawn while its rendering is suppressed (7.4), until its
   *  new state is captured. */
  held: SurfaceLike | null = null;
  /** When its tree was first drawn, on the clock, which its animations
   *  start from. */
  started = 0;
  /** When its pseudo-elements' animations are all over, on the clock:
   *  `Infinity` while one is paused or never ends. */
  endsAt = 0;

  /** Its rendering suppressed no more: the picture held goes. */
  release(): void {
    this.held?.destroy?.();
    this.held = null;
  }

  dispose(): void {
    this.release();
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
export function captureName(
  el: Element,
  style: ComputedStyle,
  scopeTree: object | null = null,
): string | null {
  const name = style.viewTransitionName;
  if (name === 'none') return null;
  // a shadow tree's sheet names nothing the document's transition captures
  // (CSS View Transitions 2, 3.1: its document-scoped name is `none`), and
  // one started on an element takes the names of that element's tree, as
  // Chromium does (`scoped/shadow-dom`)
  const tree = style.viewTransitionNameTree;
  if (tree !== scopeTree) return null;
  if (name === 'auto' || name === 'match-element') {
    const id = el.attribs.id;
    // a name of its own the `id` makes, one for every element of that
    // `id`, and never the `id` itself, which a rule names — where the rule
    // is of the element's own tree: through `::part()` it is the element's
    // (CSS View Transitions 2, 3.1)
    if (name === 'auto' && id && shadowRootAround(el) === tree) {
      return `-ua-id-${id}`;
    }
    let made = ELEMENT_NAMES.get(el);
    if (!made) {
      made = `-ua-element-${++elementNames}`;
      ELEMENT_NAMES.set(el, made);
    }
    return made;
  }
  // as a selector's argument reads it: `first\!` is `first!`
  return name.includes('\\') ? readIdent(name, 0).value : name;
}

/** The classes an element is captured with (CSS View Transitions 2, 3.2). */
export function captureClasses(
  style: ComputedStyle,
  scopeTree: object | null = null,
): string[] {
  // a shadow tree's are no document's (CSS View Transitions 2, 3.2)
  if (style.viewTransitionClassTree !== scopeTree) return [];
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
 * The rectangle a view transition captures of an element's ink, in the
 * same coordinates as the ink and the viewport: the intersection of the
 * ink with the viewport expanded by one viewport on each side, or, where
 * that is empty (the element is fully offscreen past that band), up to
 * one viewport of ink from the edge nearest the viewport — so a massive
 * element below the viewport still yields its top strip, and a far-away
 * one its whole box when that fits (WPT `massive-element-*-offscreen`,
 * `far-away-capture`). Null where nothing has size.
 */
export function captureClipRect(
  ink: { x: number; y: number; width: number; height: number },
  viewport: { x: number; y: number; width: number; height: number },
): { x0: number; y0: number; x1: number; y1: number } | null {
  const { x: left, y: top, width: iw, height: ih } = ink;
  const { x: vx, y: vy, width: vw, height: vh } = viewport;
  if (!(iw > 0 && ih > 0) || !(vw > 0 && vh > 0)) return null;
  const right = left + iw;
  const bottom = top + ih;
  const bandL = vx - vw;
  const bandT = vy - vh;
  const bandR = vx + 2 * vw;
  const bandB = vy + 2 * vh;
  let x0 = Math.floor(Math.max(left, bandL));
  let y0 = Math.floor(Math.max(top, bandT));
  let x1 = Math.ceil(Math.min(right, bandR));
  let y1 = Math.ceil(Math.min(bottom, bandB));
  if (x1 > x0 && y1 > y0) return { x0, y0, x1, y1 };

  // empty: clamp ~one viewport to the ink from the edge nearest the band
  if (right <= bandL) {
    x1 = Math.ceil(right);
    x0 = Math.floor(Math.max(left, right - vw));
  } else if (left >= bandR) {
    x0 = Math.floor(left);
    x1 = Math.ceil(Math.min(right, left + vw));
  } else {
    x0 = Math.floor(Math.max(left, bandL));
    x1 = Math.ceil(Math.min(right, bandR));
    if (!(x1 > x0)) {
      x0 = Math.floor(left);
      x1 = Math.ceil(Math.min(right, left + vw));
    }
  }
  if (bottom <= bandT) {
    y1 = Math.ceil(bottom);
    y0 = Math.floor(Math.max(top, bottom - vh));
  } else if (top >= bandB) {
    y0 = Math.floor(top);
    y1 = Math.ceil(Math.min(bottom, top + vh));
  } else {
    y0 = Math.floor(Math.max(top, bandT));
    y1 = Math.ceil(Math.min(bottom, bandB));
    if (!(y1 > y0)) {
      y0 = Math.floor(top);
      y1 = Math.ceil(Math.min(bottom, top + vh));
    }
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x0, y0, x1, y1 };
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
