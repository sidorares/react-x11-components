// What a style sheet's animations make of the shapes in a drawing.
//
// What is inside an inline `<svg>` has no boxes and no computed style
// (`shapes.ts`), and so no animation on the document's timeline: the frame
// loop restyles boxes. But a drawing's elements are animated by CSS as a
// paragraph is (SVG 2, 6.1; CSS Animations 1 applies to any element), and an
// explainer's diagram builds itself up a group at a time — `.fx { opacity: 0
// }` and `.play .fx { animation: rise .5s forwards }`, whose last frame is
// the only place its `opacity: 1` is written. Not run, every such group
// stayed at the opacity it starts from, and the diagram was empty.
//
// So the drawing's cascade (`Cascade.shapeStyles`) reads each element's
// animation lists and `transform` with its shape properties, and this
// samples them: on a clock of the drawing's elements kept here, across
// builds and cascades, as `AnimationTimeline` keeps a box's. What an
// animation sets of a shape's properties is written over what the rules
// gave, and its transform is a matrix in the element's `transform`, where
// `SvgView` reads one. Each drawing an animation is under way in is noted
// with when it next changes, and the element asks it again then
// (`HtmlViewNode._shapeFrame`).
import type { Element } from 'domhandler';
import {
  NO_ANIMATIONS,
  animationLonghand,
  ANIMATION_LONGHANDS,
  parseAnimation,
  progressAt,
  spanAt,
  timingAt,
  tracksOf,
} from './animation.js';
import type { Animations } from './animation.js';
import { blend } from './color.js';
import { interpolateTransforms } from './interpolate.js';
import type { KeyframesRule } from './parse.js';
import { isShapeProp, shapeInitial, shapeValue } from './shapes.js';
import type { ShapeContext } from './shapes.js';
import { IDENTITY, multiply, parseTransform } from './transform.js';
import type { Matrix, TransformFunction } from './transform.js';
import { parseLength, splitValue } from './values.js';
import type { Len } from './values.js';

/** A rectangle in an element's user units. */
export interface ShapeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The properties of a drawing's elements read here and not by `SvgView`:
 *  what animates them, and what moves them. */
const MOTION = new Set([
  'animation',
  ...Object.keys(ANIMATION_LONGHANDS),
  'transform',
  'transform-origin',
  'transform-box',
]);

/** Whether a declaration says how a drawing's element animates or moves. */
export function isShapeMotion(prop: string): boolean {
  return MOTION.has(prop);
}

/** What an element's rules say of how it animates and moves, as they
 *  cascade: its animation lists, and its transform, origin and box as
 *  written. */
export interface ShapeMotion {
  animations: Animations;
  transform: string | null;
  origin: string | null;
  box: string | null;
}

/** One declaration of how an element moves, over what came before it in
 *  cascade order. Null where none had been made and this makes none. */
export function addMotion(
  motion: ShapeMotion | null,
  prop: string,
  value: string,
): ShapeMotion | null {
  const was: ShapeMotion = motion ?? {
    animations: NO_ANIMATIONS,
    transform: null,
    origin: null,
    box: null,
  };
  const v = value.trim();
  if (prop === 'animation') {
    const parsed = parseAnimation(v);
    return parsed ? { ...was, animations: parsed } : motion;
  }
  const key = ANIMATION_LONGHANDS[prop];
  if (key) {
    const set = animationLonghand(was.animations, key, v);
    return set ? { ...was, animations: set } : motion;
  }
  if (prop === 'transform') return { ...was, transform: v };
  if (prop === 'transform-origin') return { ...was, origin: v };
  if (prop === 'transform-box') return { ...was, box: v.toLowerCase() };
  return motion;
}

/** What one element's motion comes to now: the properties its animations
 *  set, and its transform as an SVG matrix, `none` where it has none; null
 *  where it changes nothing. */
export type MotionResult = Record<string, string> | null;

/**
 * The clock of the drawings' elements, kept by the element that draws them
 * across builds and cascades, as the document's timeline is: when each
 * element's animations started, by their place in its list and their
 * name, and which drawings have one under way, with when each next changes.
 */
export class ShapeAnimations {
  /** The time now, in milliseconds. */
  now: () => number;
  /** Whether animations run, or are drawn at their start
   *  (`animate={false}`), as the document's are. */
  running: () => boolean = () => true;
  /** Where an element takes up its user space (`getBBox`), for a
   *  `transform-box: fill-box`; null where it cannot be measured. */
  bbox: ((el: Element) => ShapeBox | null) | null = null;
  /** Told when a drawing is noted with a time it next changes at. */
  onDue: (() => void) | null = null;
  private _starts = new WeakMap<Element, Map<string, number>>();
  private _due = new Map<Element, number>();

  constructor(now: () => number) {
    this.now = now;
  }

  /** The drawings due to change by `at`, taken off the list: the element
   *  asks them again, which notes them again where one still runs. */
  takeDue(at: number): Set<Element> {
    const out = new Set<Element>();
    for (const [root, next] of this._due) {
      if (next <= at) {
        out.add(root);
        this._due.delete(root);
      }
    }
    return out;
  }

  /** When the next of them is due, Infinity where none is. */
  nextDue(): number {
    let next = Infinity;
    for (const at of this._due.values()) if (at < next) next = at;
    return next;
  }

  /** A drawing is asked again: what it noted is of the ask before. */
  begin(root: Element): void {
    this._due.delete(root);
  }

  /** A drawing changes again at `at`, or no sooner than it said. */
  private _note(root: Element, at: number): void {
    const was = this._due.get(root);
    if (was === undefined || at < was) this._due.set(root, at);
    if (was === undefined || at < was) this.onDue?.();
  }

  /**
   * What `el`'s animations and transform make of it now, over `own`, what
   * the rules give it: each property an animation sets, at the value it
   * comes to, and `transform` as a matrix in user units about its origin.
   * `root` is the drawing it is in, whose viewport a `view-box` is.
   */
  sample(
    el: Element,
    root: Element,
    motion: ShapeMotion,
    own: Record<string, string> | null,
    keyframesOf: (name: string) => KeyframesRule | null,
    ctx: ShapeContext,
  ): MotionResult {
    const { animations } = motion;
    const running = this.running();
    const now = this.now();
    const starts = this._starts.get(el);
    const kept = new Map<string, number>();
    let out: Record<string, string> | null = null;
    // the transform at its keyframes, which are interpolated as lists
    let transform: TransformFunction[] | null | undefined = undefined;
    let next = Infinity;
    const underlying = (prop: string): string => {
      const mine = own?.[prop];
      if (mine !== undefined && mine !== 'inherit') return mine;
      const attr = el.attribs[prop];
      const read = attr === undefined ? null : shapeValue(prop, attr, ctx);
      return read ?? shapeInitial(prop) ?? '';
    };
    for (let i = 0; i < animations.names.length; i += 1) {
      const name = animations.names[i];
      if (name === null) continue;
      const rule = keyframesOf(name);
      if (!rule) continue;
      const id = `${i}:${name}`;
      const start = starts?.get(id) ?? now;
      kept.set(id, start);
      const timing = timingAt(animations, i);
      const paused =
        animations.playStates[i % animations.playStates.length] === 'paused';
      const time = running && !paused ? now - start : 0;
      const at = progressAt(timing, time);
      if (running && !paused) {
        // a frame from now while it runs, and the end of its delay before
        if (at.phase === 'active') next = Math.min(next, now + 16);
        else if (at.phase === 'before') {
          next = Math.min(next, start + Math.max(timing.delay, 0));
        }
      }
      if (at.progress === null) continue;
      const easing = animations.easings[i % animations.easings.length];
      for (const [prop, frames] of tracksOf(rule)) {
        const span = spanAt(frames, at.progress, easing);
        if (prop === 'transform') {
          const own = this._transformOf(motion.transform, ctx);
          const from = span.from
            ? this._transformOf(span.from.declaration.value, ctx)
            : own;
          const to = span.to
            ? this._transformOf(span.to.declaration.value, ctx)
            : own;
          if (from === undefined || to === undefined) continue;
          const mixed = interpolateTransforms(from, to, span.q);
          transform = mixed === undefined ? (span.q < 0.5 ? from : to) : mixed;
          continue;
        }
        if (!isShapeProp(prop) || prop === 'font') continue;
        const read = (value: string): string | null =>
          shapeValue(prop, value, ctx);
        const a = span.from
          ? read(span.from.declaration.value)
          : underlying(prop);
        const b = span.to ? read(span.to.declaration.value) : underlying(prop);
        if (a === null || b === null) continue;
        (out ??= {})[prop] = mix(prop, a === 'inherit' ? b : a, b, span.q);
      }
    }
    if (kept.size) this._starts.set(el, kept);
    else if (starts) this._starts.delete(el);
    if (next < Infinity) this._note(root, next);
    // a transform the rules give it, where no animation set one
    if (transform === undefined && motion.transform !== null) {
      transform = this._transformOf(motion.transform, ctx);
      if (transform === undefined) return out;
    }
    if (transform !== undefined) {
      (out ??= {}).transform =
        transform === null
          ? 'none'
          : matrixText(this._placed(el, root, transform, motion, ctx));
    }
    return out;
  }

  private _transformOf(
    value: string | null,
    ctx: ShapeContext,
  ): TransformFunction[] | null | undefined {
    if (value === null) return null;
    return parseTransform(value, ctx.units);
  }

  /** A transform list as the matrix it comes to in user units, about the
   *  element's origin in its reference box (CSS Transforms 1, 6, 8). */
  private _placed(
    el: Element,
    root: Element,
    list: readonly TransformFunction[],
    motion: ShapeMotion,
    ctx: ShapeContext,
  ): Matrix {
    const box = this._referenceBox(el, root, motion.box);
    // lengths were read in device pixels, which a drawing's user units are
    // not: what scales them is the scale it is drawn at
    const scale = ctx.units.scale || 1;
    let m = IDENTITY;
    for (const fn of list) {
      if ('by' in fn) {
        m = multiply(m, [
          1,
          0,
          0,
          1,
          lengthOf(fn.by[0], box.width * scale) / scale,
          lengthOf(fn.by[1], box.height * scale) / scale,
        ]);
      } else if ('matrix' in fn) {
        const [a, b, c, d, e, f] = fn.matrix;
        m = multiply(m, [a, b, c, d, e / scale, f / scale]);
      } else {
        const s = fn.solid;
        m = multiply(m, [s[0], s[1], s[4], s[5], s[12] / scale, s[13] / scale]);
      }
    }
    const [ox, oy] = originIn(motion.origin, box, ctx);
    return multiply(multiply([1, 0, 0, 1, ox, oy], m), [1, 0, 0, 1, -ox, -oy]);
  }

  /** The box a transform's percentages and origin are of: the element's
   *  own for `fill-box` and `stroke-box`, and the drawing's viewport for
   *  the rest, from its user space's origin (CSS Transforms 1, 4). */
  private _referenceBox(
    el: Element,
    root: Element,
    which: string | null,
  ): ShapeBox {
    if (which === 'fill-box' || which === 'stroke-box') {
      const box = this.bbox?.(el) ?? null;
      if (box) return box;
    }
    const view = (root.attribs.viewBox ?? root.attribs.viewbox ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (view.length === 4 && view.every(Number.isFinite)) {
      return { x: 0, y: 0, width: view[2], height: view[3] };
    }
    const width = parseFloat(root.attribs.width ?? '');
    const height = parseFloat(root.attribs.height ?? '');
    return {
      x: 0,
      y: 0,
      width: Number.isFinite(width) ? width : 300,
      height: Number.isFinite(height) ? height : 150,
    };
  }
}

/** A length, or a percentage of `of`. */
function lengthOf(len: Len, of: number): number {
  if (typeof len === 'number') return len;
  if (len === 'auto') return 0;
  return (len.pct / 100) * of + (len.px ?? 0);
}

/** Where a `transform-origin` is in user units: `0 0` where none is set,
 *  as an SVG element's is (CSS Transforms 1, 6). */
function originIn(
  value: string | null,
  box: ShapeBox,
  ctx: ShapeContext,
): [number, number] {
  if (value === null) return [box.x, box.y];
  const parts = splitValue(value.toLowerCase());
  let x: number | null = null;
  let y: number | null = null;
  const scale = ctx.units.scale || 1;
  const at = (part: string, of: number): number | null => {
    const len = parseLength(part, ctx.units);
    if (len === null || len === 'auto') return null;
    if (typeof len === 'number') return len / scale;
    return (len.pct / 100) * of + (len.px ?? 0) / scale;
  };
  const rest: string[] = [];
  for (const part of parts.slice(0, 2)) {
    if (part === 'left') x = 0;
    else if (part === 'right') x = box.width;
    else if (part === 'top') y = 0;
    else if (part === 'bottom') y = box.height;
    else if (part === 'center') rest.push(part);
    else rest.push(part);
  }
  for (const part of rest) {
    if (part === 'center') {
      if (x === null) x = box.width / 2;
      else if (y === null) y = box.height / 2;
    } else if (x === null) x = at(part, box.width);
    else if (y === null) y = at(part, box.height);
  }
  if (parts.length === 1 && y === null) y = box.height / 2;
  return [box.x + (x ?? 0), box.y + (y ?? 0)];
}

/** The properties that are numbers, each between its two. */
const NUMERIC = new Set([
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'stop-opacity',
  'stroke-width',
  'stroke-dashoffset',
  'stroke-miterlimit',
]);

/** A shape's property `q` of the way from `a` to `b`, as CSS interpolates
 *  it (CSS Values 4, 3; CSS Color 4, 12): numbers and colours between
 *  their two, and everything else from one to the other half way. */
function mix(prop: string, a: string, b: string, q: number): string {
  if (a === b) return a;
  if (NUMERIC.has(prop)) {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      let v = x + (y - x) * q;
      if (prop.endsWith('opacity')) v = Math.min(1, Math.max(0, v));
      else if (prop !== 'stroke-dashoffset') v = Math.max(0, v);
      return String(v);
    }
  }
  if (
    prop === 'fill' ||
    prop === 'stroke' ||
    prop === 'color' ||
    prop === 'stop-color'
  ) {
    const mixed = blend(a, b, q);
    if (mixed !== null) return mixed;
  }
  if (prop === 'stroke-dasharray' && a !== 'none' && b !== 'none') {
    const xs = a.split(' ').map(Number);
    const ys = b.split(' ').map(Number);
    if (xs.length === ys.length) {
      return xs.map((x, i) => Math.max(0, x + (ys[i] - x) * q)).join(' ');
    }
  }
  return q < 0.5 ? a : b;
}

/** A matrix as an SVG transform attribute has it. */
function matrixText(m: Matrix): string {
  return `matrix(${m.map((n) => +n.toFixed(6)).join(' ')})`;
}
