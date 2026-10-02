// <Html>'s half of react-x11's sprite seam (sidorares/react-x11#819): the
// elements whose CSS animation the render server can run, offered to the
// presenter as parts of the document's drawing (`HtmlViewNode.sprites()`),
// each with its frames sampled from the document's own interpolation.
//
// What is eligible is what a browser hands its compositor
// (docs/prd-html-animations.md §3): an element whose one animation sets
// only `opacity` and the transform properties, running now, drawn in a box
// of its own, inside nothing that fades, turns, clips, masks or is fixed,
// and that nothing the document paints after it draws within reach of
// while it runs. The last is the document's to answer — core's presenter
// cannot see inside the element — and it is answered in the order the
// document paints (`paintedAfter`): the layer is over all of the
// document, which is right for what is painted before the element and
// wrong for anything painted after it. A badge painted over a card it does
// not belong to keeps the card on the document's clock; a toast over the
// page, a panel fading in over text, a spinner and a turning card pass.
//
// The frames go over as values the document computed: the element's style
// is sampled at times through one cycle of its animation — two iterations
// where it alternates — on a timeline forked from the document's, so
// `cubic-bezier()`, `steps()`, a keyframe's own timing function, a frame
// the animation makes of the element's own value, a turn of a whole circle
// and a mixed transform list all come out as `<Html>` draws them, and the
// render server plays straight lines between them. What the layer shows at
// rest is the style after the animation's end, as its fill mode leaves it:
// the end frame it holds, or the element's own value.

import { progressAt, timingAt, tracksOf } from './css/animation.js';
import type { Timing } from './css/animation.js';
import type { Cascade } from './css/cascade.js';
import { masked } from './css/style.js';
import type { ComputedStyle } from './css/style.js';
import type { AnimationTimeline, Running } from './css/timeline.js';
import { matrixOf, transformed } from './css/transform.js';
import { resolve } from './css/values.js';
import type { Box, BoxTree } from './layout/boxes.js';
import {
  FIXED_BOXES,
  drawsAgainstViewport,
  holds,
  ownBounds,
  paintedAfter,
} from './paint.js';
import type { Element } from 'domhandler';
import type { Rect } from 'react-x11';
import type {
  Context2D,
  Sprite,
  SpriteAnimation,
  SpriteMatrix,
} from 'react-x11/node';
import { isElement } from './dom.js';

/** An animation a sprite carries: react-x11's, with the delay and the
 *  repeat a document always gives it. */
export interface DocumentSpriteAnimation extends SpriteAnimation {
  /** Milliseconds from now; negative where the cycle began that far back. */
  delay: number;
  repeat: number;
}

/** A part of the document's drawing, as react-x11's `Node.sprites()` takes
 *  one, with everything a document always says about it. */
export interface DocumentSprite extends Sprite {
  reach: Rect;
  version: string;
  opacity: number;
  transform: SpriteMatrix;
  origin: { x: number; y: number };
  animations: DocumentSpriteAnimation[];
}

/** The properties a sprite's layer can carry. Anything else an animation
 *  sets — a colour, a width, `transform-origin` — is drawn, and keeps the
 *  element on the document's clock. */
const LIFTABLE = new Set([
  'opacity',
  'transform',
  'translate',
  'rotate',
  'scale',
]);

/** How often a cycle is sampled: a display's frames. */
const SAMPLE_MS = 1000 / 60;

/** No more than this many frames a cycle: ten seconds of them. */
const MAX_SAMPLES = 600;

/** Past this many device pixels on a side a part is left to the document,
 *  as core leaves it (src/cocoa/sprites.js). */
const MAX_SIDE = 8192;

/** What the document gives the sprites it offers. */
export interface SpriteHost {
  tree: BoxTree;
  cascade: Cascade;
  timeline: AnimationTimeline;
  /** The time on the document's clock. */
  now: number;
  /** Each element's first box (`HtmlViewNode._firstBoxesOf`). */
  boxes: ReadonlyMap<Element, Box>;
  /** Whether the render server ran an animation of `el`'s to its end. */
  ended(el: Element, id: string): boolean;
}

/** An element's one animation, where it is one a sprite can carry. */
export interface Lift {
  el: Element;
  box: Box;
  name: string;
  run: Readonly<Running>;
  timing: Timing;
  /** When its active phase began, on the document's clock. */
  begin: number;
  /** One cycle, in milliseconds: an iteration, or two where it alternates. */
  cycle: number;
  /** What its frames are sampled from: the animation, and the box whose
   *  size its percentages are of. */
  id: string;
  opacity: boolean;
  transform: boolean;
}

/**
 * The animation of `el` a sprite can carry, or null: exactly one named
 * animation with frames, playing, in its active phase, setting only what a
 * layer carries — and not one the render server already ran to its end.
 * Cheap, and asked every frame: the frames are sampled once (`partOf`).
 */
export function liftOf(host: SpriteHost, el: Element): Lift | null {
  const style = host.tree.styles.get(el)?.style;
  const box = host.boxes.get(el);
  if (!style || !box || box.el !== el) return null;
  const animations = style.animations;
  let index = -1;
  for (let i = 0; i < animations.names.length; i += 1) {
    if (animations.names[i] === null) continue;
    if (index >= 0) return null;
    index = i;
  }
  if (index < 0) return null;
  const name = animations.names[index]!;
  const rule = host.cascade.keyframes(name);
  if (!rule) return null;
  const plays = animations.playStates;
  if (plays[index % plays.length] === 'paused') return null;
  let opacity = false;
  let transform = false;
  for (const prop of tracksOf(rule).keys()) {
    if (!LIFTABLE.has(prop)) return null;
    if (prop === 'opacity') opacity = true;
    else transform = true;
  }
  const run = host.timeline.runsOf(el)?.find((r) => r?.name === name);
  if (!run || run.hold !== null) return null;
  const timing = timingAt(animations, index);
  if (!(timing.duration > 0) || !(timing.iterations > 0)) return null;
  if (progressAt(timing, host.now - run.start).phase !== 'active') return null;
  const alternates =
    timing.direction === 'alternate' ||
    timing.direction === 'alternate-reverse';
  const id = [
    name,
    run.start,
    timing.duration,
    timing.delay,
    timing.iterations,
    timing.direction,
    timing.fill,
    box.width,
    box.height,
  ].join('|');
  if (host.ended(el, id)) return null;
  return {
    el,
    box,
    name,
    run,
    timing,
    begin: run.start + timing.delay,
    cycle: alternates ? 2 * timing.duration : timing.duration,
    id,
    opacity,
    transform,
  };
}

/**
 * Whether `box` can be drawn by a layer at all: a box of its own, not
 * fixed, drawing nothing against the viewport, inside nothing whose group,
 * matrix, clip or mask would have to take the layer in — and inside no
 * element whose own animation runs, which may turn into any of those.
 */
function liftableBox(host: SpriteHost, box: Box): boolean {
  if (box.kind === 'inline' || box.kind === 'text' || box.kind === 'break') {
    return false;
  }
  if (box.pseudo || !box.parent) return false;
  if (box.style.position === 'fixed' || drawsAgainstViewport(box)) {
    return false;
  }
  if (box.style.clipPath || box.style.clip || masked(box.style)) return false;
  // one fixed to the viewport in it is drawn where the viewport is, which
  // the layer does not follow
  for (const fixed of FIXED_BOXES.get(host.tree) ?? NO_BOXES) {
    if (holds(box, fixed)) return false;
  }
  for (let at: Box | null = box.parent; at; at = at.parent) {
    const style = at.style;
    if (style.opacity < 1 || transformed(style)) return false;
    if (style.position === 'fixed') return false;
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      // the root's is the viewport's, and so is the body's it gives it
      // (`propagateOverflow`), which leaves the body's own visible
      if (at.parent) return false;
    }
    if (style.clipPath || style.clip || masked(style)) return false;
    if (at.el && host.timeline.isLive(at.el)) return false;
  }
  return true;
}

/** `rect` through `m` about `origin`: the bounds of its corners. */
function mapRect(rect: Rect, m: SpriteMatrix, ox: number, oy: number): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ]) {
    const dx = px - ox;
    const dy = py - oy;
    const x = m[0] * dx + m[2] * dy + m[4] + ox;
    const y = m[1] * dx + m[3] * dy + m[5] + oy;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/**
 * Whether anything in the document but `box`'s ancestors and descendants
 * puts ink within `extent`, in the document's coordinates — or an ancestor
 * draws an outline, which goes over what it holds: painted before the box
 * or after it, for a box whose place in the paint order `paintedAfter`
 * cannot tell. A subtree whose ink misses the extent is passed over whole.
 */
function crowded(tree: BoxTree, box: Box, extent: Rect): boolean {
  const path = new Set<Box>();
  for (let at = box.parent; at; at = at.parent) path.add(at);
  const stack: Box[] = [tree.root];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === box) continue;
    if (path.has(at)) {
      const outline = at.style.outlineWidth;
      if (outline > 0 && at.style.outlineStyle !== 'none') return true;
      for (const child of at.children) stack.push(child);
      continue;
    }
    if (!(at.boundsWidth > 0 && at.boundsHeight > 0)) continue;
    const ink = {
      x: at.boundsX,
      y: at.boundsY,
      width: at.boundsWidth,
      height: at.boundsHeight,
    };
    if (overlaps(ink, extent)) return true;
  }
  return false;
}

/** The frames of one cycle, sampled from the element's style on a fork of
 *  the document's timeline, and the style the animation leaves at rest. */
function sample(
  host: SpriteHost,
  parentStyle: ComputedStyle,
  inFlex: boolean,
  lift: Lift,
): { opacities: number[]; matrices: SpriteMatrix[]; rest: ComputedStyle } {
  const { el, box } = lift;
  const cascade = host.cascade;
  const fork = host.timeline.fork(el);
  const was = cascade.timeline;
  const at = (time: number): ComputedStyle => {
    fork.now = time;
    return cascade.styleFor(el, parentStyle, inFlex);
  };
  const opacities: number[] = [];
  const matrices: SpriteMatrix[] = [];
  const n = Math.max(
    2,
    Math.min(MAX_SAMPLES, Math.round(lift.cycle / SAMPLE_MS)),
  );
  cascade.timeline = fork;
  try {
    for (let k = 0; k <= n; k += 1) {
      // the last frame a breath short of the cycle's end, which is the
      // next one's start
      const u = k === n ? lift.cycle - 1e-3 : (k / n) * lift.cycle;
      const style = at(lift.begin + u);
      opacities.push(Math.min(1, Math.max(0, style.opacity)));
      matrices.push([
        ...matrixOf(style, box.width, box.height),
      ] as SpriteMatrix);
    }
    const { iterations, duration } = lift.timing;
    // past the end, as the fill mode leaves it; a loop never gets there,
    // and rests where it is
    const rest =
      iterations === Infinity
        ? box.style
        : at(lift.begin + iterations * duration + 1);
    return { opacities, matrices, rest };
  } finally {
    cascade.timeline = was;
  }
}

/**
 * A sprite's frames and geometry, in the document's coordinates: what is
 * costly to make — its frames sampled, and the document searched for
 * anything within its reach — and the same for as long as the document
 * draws and lays it out as it did. `HtmlViewNode` keeps it, and makes the
 * sprite each frame from it (`describe`).
 */
export interface Part {
  lift: Lift;
  /** The box with no transform, where layout would have put it. */
  rect: Rect;
  reach: Rect;
  origin: { x: number; y: number };
  /** The translation layout moved the box by: undone when it is painted on
   *  its layer, whose matrix carries each frame's. */
  translation: [number, number];
  opacity: number;
  transform: SpriteMatrix;
  animations: DocumentSpriteAnimation[];
  /** Everywhere it can be while it runs, in the document's coordinates. */
  extent: Rect;
  /** The boxes fixed to the viewport, which a scroll moves over the
   *  document: one within `extent` where the viewport has it now covers
   *  the element there, or ought to (`HtmlViewNode.sprites`). */
  fixed: readonly Box[];
}

/**
 * The part `lift` is, or null where the element cannot be one: in a box a
 * layer cannot draw (`liftableBox`), too large, or within reach of what
 * the document paints after it (`paintedAfter`) — where that cannot be
 * told, of any ink but its own and its ancestors' (`crowded`).
 */
export function partOf(host: SpriteHost, lift: Lift): Part | null {
  const { el, box } = lift;
  const tree = host.tree;
  const kept = tree.styles.get(el);
  if (!kept || !liftableBox(host, box)) return null;
  const parent = isElement(el.parent) ? el.parent : null;
  const parentStyle = parent ? tree.styles.get(parent)?.style : tree.root.style;
  if (!parentStyle) return null;
  // Where the box would be with no transform: layout moved it by the
  // translation its style has now (`applyRelativeOffsets`), and a layer's
  // matrix carries every frame's.
  const now = matrixOf(box.style, box.width, box.height);
  const bx = box.x - now[4];
  const by = box.y - now[5];
  const own = ownBounds(box);
  const reach = {
    x: own.x - now[4],
    y: own.y - now[5],
    width: own.width,
    height: own.height,
  };
  if (reach.width > MAX_SIDE || reach.height > MAX_SIDE) return null;
  const { opacities, matrices, rest } = sample(
    host,
    parentStyle,
    kept.inFlex,
    lift,
  );
  const origin = box.style.transformOrigin;
  const ox = bx + resolve(origin[0], box.width, 0);
  const oy = by + resolve(origin[1], box.height, 0);
  const transform = [...matrixOf(rest, box.width, box.height)] as SpriteMatrix;
  // everywhere it can be: its reach where it rests, and through every frame
  let extent = mapRect(reach, transform, ox, oy);
  if (lift.transform) {
    for (const m of matrices) {
      extent = unionRect(extent, mapRect(reach, m, ox, oy));
    }
  }
  // what is painted before it is under the layer as it is under it, and
  // what is painted after it must not be
  if (paintedAfter(box, extent) ?? crowded(tree, box, extent)) return null;
  const { iterations, duration } = lift.timing;
  const repeat = lift.cycle === duration ? iterations : iterations / 2;
  const animations: DocumentSpriteAnimation[] = [];
  if (lift.opacity) {
    animations.push({
      id: `${lift.id}|opacity`,
      property: 'opacity',
      values: opacities,
      duration: lift.cycle,
      delay: 0,
      repeat,
    });
  }
  if (lift.transform) {
    animations.push({
      id: `${lift.id}|transform`,
      property: 'transform',
      values: matrices,
      duration: lift.cycle,
      delay: 0,
      repeat,
    });
  }
  return {
    lift,
    rect: { x: bx, y: by, width: box.width, height: box.height },
    reach,
    origin: { x: ox, y: oy },
    translation: [now[4], now[5]],
    opacity: Math.min(1, Math.max(0, rest.opacity)),
    transform,
    animations,
    extent,
    fixed: FIXED_BOXES.get(tree) ?? NO_BOXES,
  };
}

const NO_BOXES: readonly Box[] = [];

/**
 * The sprite a part is this frame: in the window's coordinates, with the
 * document's origin at (`originX`, `originY`), its animations' delays
 * counted from `now` — what the presenter reads when it attaches one — and
 * painted by `paint`, which draws a box as the document would.
 */
export function describe(
  part: Part,
  key: string,
  version: string,
  originX: number,
  originY: number,
  now: number,
  paint: (ctx: Context2D, box: Box) => void,
): DocumentSprite {
  const shift = (r: Rect): Rect => ({
    x: r.x + originX,
    y: r.y + originY,
    width: r.width,
    height: r.height,
  });
  const delay = part.lift.begin - now;
  const [tx, ty] = part.translation;
  const box = part.lift.box;
  return {
    key,
    rect: shift(part.rect),
    reach: shift(part.reach),
    version,
    paint(ctx: Context2D) {
      ctx.save();
      try {
        // drawn where it would be with no transform: the layer's matrix
        // puts it where each frame has it
        ctx.translate(-tx, -ty);
        paint(ctx, box);
      } finally {
        ctx.restore();
      }
    },
    opacity: part.opacity,
    transform: part.transform,
    origin: { x: part.origin.x + originX, y: part.origin.y + originY },
    animations: part.animations.map((a) => ({ ...a, delay })),
  };
}
