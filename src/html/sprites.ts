// <Html>'s half of react-x11's sprite seam (sidorares/react-x11#819): the
// elements whose CSS animation or transition the render server can run,
// offered to the presenter as parts of the document's drawing
// (`HtmlViewNode.sprites()`), each with its frames sampled from the
// document's own interpolation.
//
// What is eligible is what a browser hands its compositor
// (docs/prd-html-animations.md §3): an element whose animations and
// transitions set only `opacity` and the transform properties, one of them
// a property, each running now, drawn in a box of its own, inside nothing
// that fades, turns or masks — a box that clips it cuts its layer, one
// fixed to the viewport, or in one, has its layer stay where the viewport
// is, and one inside another element on a layer goes in that one's layer
// (`partOf`'s `parent`) — and that nothing the document paints after it
// draws within reach of while it runs, but another part offered with it.
// The last is the document's to answer — core's presenter cannot see
// inside the element — and it is answered in the order the document paints
// (`paintedAfter`): the layer is over all of the document, which is right
// for what is painted before the element and wrong for anything painted
// after it, but for a part painted after it, whose layer is over its own,
// and which the presenter takes it off its layer with in a frame that
// turns that one down (`coveredAfter`, react-x11#852). A badge painted
// over a card it does not belong to keeps the card on the document's
// clock; a toast over the page, a panel fading in over text, a spinner, a
// turning card and the rows of a list that slide in one into the next
// pass.
//
// A box turned out of the plane goes over with its whole 4×4, seen in the
// perspective the document sees it in (`solidFrames`), and one that runs no
// animation goes over too where a perspective shows it, as a part with
// none (`stillLiftOf`): the render server draws it through the matrix on
// the GPU, where the document draws it a tile at a time at every paint.
//
// The frames go over as values the document computed: the element's style
// is sampled at times through one cycle of its animation — two iterations
// where it alternates, a transition from its start to its end — on a
// timeline forked from the document's, so `cubic-bezier()`, `steps()`, a
// keyframe's own timing function, a frame the animation makes of the
// element's own value, a turn of a whole circle and a mixed transform list
// all come out as `<Html>` draws them, and the render server plays
// straight lines between them. What the layer shows at rest is the style
// after the animation's end, as its fill mode leaves it — the end frame it
// holds, or the element's own value — and after a transition's, its end.

import { progressAt, timingAt, tracksOf } from './css/animation.js';
import { rgbaOf } from './css/color.js';
import { animationTree } from './css/cascade.js';
import type { Cascade } from './css/cascade.js';
import { masked, sameValue } from './css/style.js';
import type { ComputedStyle } from './css/style.js';
import type { AnimationTimeline, Transit } from './css/timeline.js';
import { matrix4Of, matrixOf, outOfPlane } from './css/transform.js';
import type { Matrix } from './css/transform.js';
import {
  facesAway,
  lift as lift4,
  multiply4,
  translate4,
} from './css/transform3d.js';
import type { Mat4 } from './css/transform3d.js';
import { inkColor, resolve } from './css/values.js';
import { perspectiveAround, placedMatrix } from './layout/block.js';
import { GENERATED_FROM } from './layout/boxes.js';
import type { Box, BoxTree } from './layout/boxes.js';
import {
  FIXED_BOXES,
  clipFor,
  clipsOverflow,
  cornersOf,
  drawnAtViewport,
  drawsAgainstViewport,
  drawsNothing,
  hasRect,
  holds,
  ownBounds,
  shadowOutsets,
  paintedAfter,
  spreadCorners,
} from './paint.js';
import type { Element } from 'domhandler';
import type { Rect } from 'react-x11';
import type {
  Context2D,
  Sprite,
  SpriteAnimation,
  SpriteColor,
  SpriteMatrix,
  SpriteMatrix3D,
  SpriteShadow,
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
 *  one, with everything a document always says about it — its `paint`
 *  among it, since nothing a document offers is a source that shows
 *  itself (`contents`). */
export interface DocumentSprite extends Sprite {
  paint(ctx: Context2D, children?: ReadonlySet<string>): void;
  reach: Rect;
  version: string;
  opacity: number;
  transform: LayerMatrix;
  origin: { x: number; y: number };
  animations: DocumentSpriteAnimation[];
}

/** A layer's matrix: one of the plane, or `matrix3d()`'s sixteen numbers
 *  for a part turned out of it and seen in a perspective. */
export type LayerMatrix = SpriteMatrix | SpriteMatrix3D;

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

/** A corner of a part turned out of the plane no further in front of the
 *  viewer than this is behind them, as core has it: nowhere on the page,
 *  and its part the document's, which cuts it where the plane meets the
 *  viewer's. */
const W_NEAR = 1e-6;

/** Whose animations a sprite carries: an element's own (''), or those of
 *  its `::before` or its `::after`. */
export type Pseudo = '' | 'before' | 'after';

/** What the document gives the sprites it offers. */
export interface SpriteHost {
  tree: BoxTree;
  cascade: Cascade;
  timeline: AnimationTimeline;
  /** The time on the document's clock. */
  now: number;
  /** Device pixels to a CSS pixel. */
  scale: number;
  /** Whether a pane scrolls the element, moving the document under what
   *  is drawn at the viewport (`drawnAtViewport`). */
  scrolls: boolean;
  /** Each element's first box (`HtmlViewNode._firstBoxesOf`). */
  boxes: ReadonlyMap<Element, Box>;
  /** An element's `::before` or `::after` box, where it has one. */
  pseudoBox(el: Element, which: 'before' | 'after'): Box | null;
  /** Whether the render server ran an animation of `el`'s to its end. */
  ended(el: Element, id: string): boolean;
}

/** One animation a sprite carries: one of the element's, or its
 *  transitions under way of one of the two properties a layer has — what
 *  it sets, and when it runs. */
export interface Track {
  /** What its frames are sampled from: the animation or the transitions,
   *  and the box whose size their percentages are of. */
  id: string;
  /** When it begins, on the document's clock: an animation's active phase,
   *  or the first of its transitions to start. */
  begin: number;
  /** One cycle, in milliseconds: an iteration, two where it alternates,
   *  or from its transitions' first start to their last end. */
  cycle: number;
  /** How many cycles it runs. */
  repeat: number;
  /** When it is over, on the document's clock: never, for a loop. */
  end: number;
  opacity: boolean;
  transform: boolean;
}

/** An element's animations and transitions, where a sprite can carry
 *  them: one track a property, each its own animation on the layer — or
 *  none, for a box turned out of the plane that is still
 *  (`stillLiftOf`). */
export interface Lift {
  el: Element;
  /** Whose: the element's own, or a pseudo-element's of it. */
  pseudo: Pseudo;
  box: Box;
  tracks: Track[];
  /** Every track's: what the part is made from, but for the document. */
  id: string;
  /** Whether a track moves it, which a point is hit against where the
   *  layer has it (`HtmlViewNode._followLifted`). */
  moves: boolean;
}

/**
 * The animations of `el` a sprite can carry, or of its `pseudo`, or null:
 * each named animation with frames, playing, in its active phase, setting
 * only what a layer carries, and each transition under way, in its delay
 * or after it, on what a layer carries — and no two setting one property,
 * since a layer runs one animation of each and which of two wins is the
 * cascade's to choose, not the layer's. Not one the render server already
 * ran to its end. Cheap, and asked every frame: the frames are sampled
 * once (`partOf`).
 */
export function liftOf(
  host: SpriteHost,
  el: Element,
  pseudo: Pseudo = '',
): Lift | null {
  const box = pseudo ? host.pseudoBox(el, pseudo) : host.boxes.get(el);
  const style = pseudo ? box?.style : host.tree.styles.get(el)?.style;
  if (!style || !box || (!pseudo && box.el !== el)) return null;
  const animations = style.animations;
  const runs = host.timeline.runsOf(el, pseudo);
  const plays = animations.playStates;
  const tracks: Track[] = [];
  let opacity = false;
  let transform = false;
  for (let index = 0; index < animations.names.length; index += 1) {
    const name = animations.names[index];
    if (name === null) continue;
    // a name no `@keyframes` has runs nothing (CSS Animations 1, 3)
    const rule = host.cascade.keyframes(name, animationTree(animations));
    if (!rule) continue;
    if (plays[index % plays.length] === 'paused') return null;
    let sets = false;
    let moves = false;
    for (const prop of tracksOf(rule).keys()) {
      if (!LIFTABLE.has(prop)) return null;
      if (prop === 'opacity') sets = true;
      else moves = true;
    }
    if ((sets && opacity) || (moves && transform)) return null;
    opacity ||= sets;
    transform ||= moves;
    const run = runs?.[index];
    if (!run || run.name !== name || run.hold !== null) return null;
    const timing = timingAt(animations, index);
    if (!(timing.duration > 0) || !(timing.iterations > 0)) return null;
    if (progressAt(timing, host.now - run.start).phase !== 'active') {
      return null;
    }
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
      pseudo,
    ].join('|');
    if (host.ended(el, id)) return null;
    const begin = run.start + timing.delay;
    tracks.push({
      id,
      begin,
      cycle: alternates ? 2 * timing.duration : timing.duration,
      repeat: alternates ? timing.iterations / 2 : timing.iterations,
      end: begin + timing.iterations * timing.duration,
      opacity: sets,
      transform: moves,
    });
  }
  // A transition is one iteration from where it starts to where it ends,
  // holding its start through its delay, as the layer does while it waits
  // to begin. The transform's fields go over as one matrix, as an
  // animation's do. One past its end on the document's clock rests there.
  const transits = host.timeline.transitsOf(el, pseudo);
  if (transits) {
    let fade: Readonly<Transit>[] | null = null;
    let turn: Readonly<Transit>[] | null = null;
    for (const [field, run] of transits) {
      if (host.now >= run.start + run.duration) continue;
      // a jump at the end of a delay has no frames to run
      if (!LIFTABLE.has(field) || !(run.duration > 0)) return null;
      if (field === 'opacity') (fade ??= []).push(run);
      else (turn ??= []).push(run);
    }
    if ((fade && opacity) || (turn && transform)) return null;
    for (const runs of [fade, turn]) {
      if (!runs) continue;
      let begin = Infinity;
      let end = -Infinity;
      for (const run of runs) {
        begin = Math.min(begin, run.start);
        end = Math.max(end, run.start + run.duration);
      }
      const id = [
        'transition',
        ...runs.map((run) => run.serial),
        box.width,
        box.height,
        pseudo,
      ].join('|');
      if (host.ended(el, id)) return null;
      tracks.push({
        id,
        begin,
        cycle: end - begin,
        repeat: 1,
        end,
        opacity: runs === fade,
        transform: runs === turn,
      });
    }
    opacity ||= fade !== null;
    transform ||= turn !== null;
  }
  if (!tracks.length) return null;
  return {
    el,
    pseudo,
    box,
    tracks,
    id: tracks.map((t) => t.id).join('+'),
    moves: transform,
  };
}

/**
 * A box turned out of the plane and seen in a perspective, as a part with
 * no animation: its layer is drawn through its whole matrix by the render
 * server, where the document draws such a box a tile at a time
 * (`paintProjected`), at every paint that reaches it — and on macOS each
 * tile resamples the whole surface it is cut from. A browser
 * gives every box a 3D transform a layer of its own. Null for a box drawn
 * through a matrix of the plane, or not at all, which costs the document
 * no more than any other box, and where `overLiftOf` is.
 */
export function stillLiftOf(host: SpriteHost, box: Box): Lift | null {
  const placed = placedMatrix(box);
  if (!placed || placed.length !== 9) return null;
  return overLiftOf(host, box);
}

/**
 * A box as a part with no animation, whatever it draws: one the document
 * paints over a part (`HtmlViewNode.sprites`), whose layer then stands
 * over the other's, as the document draws it over the other — or the other
 * could go on no layer at all. A browser gives such a box a layer for the
 * same reason. Null for one whose own animation or transition is under
 * way, which only a track can carry (`liftOf`): a lifted element's
 * animations are not the document's clock's. And for one that is no
 * element's box, or a pseudo-element's but its `::before`'s or its
 * `::after`'s.
 */
export function overLiftOf(host: SpriteHost, box: Box): Lift | null {
  const which = box.pseudo;
  if (which === 'first-letter') return null;
  const pseudo: Pseudo = which ?? '';
  const el = pseudo ? GENERATED_FROM.get(box) : box.el;
  if (!el) return null;
  const own = pseudo ? host.pseudoBox(el, pseudo) : host.boxes.get(el);
  if (own !== box || host.timeline.isLive(el, pseudo)) return null;
  return { el, pseudo, box, tracks: [], id: 'still', moves: false };
}

/**
 * Whether `box` can be drawn by a layer at all: a box of its own, drawing
 * nothing against the viewport, inside nothing whose group, matrix, clip
 * path, mask or filter would have to take the layer in — a box that clips it cuts
 * the layer instead (`clipFor`) — and inside no element whose own
 * animation runs, which may turn into any of those. One fixed to the
 * viewport, or in one that is, goes on a layer that stays where the
 * viewport is (`Part.atViewport`). `within` is the box of a part whose
 * layer this one's would go in: it and what is above it are that part's.
 */
function liftableBox(
  host: SpriteHost,
  box: Box,
  within: Box | null = null,
): boolean {
  if (box.kind === 'inline' || box.kind === 'text' || box.kind === 'break') {
    return false;
  }
  // a first letter is its element's text, and a pseudo-element of the
  // others is a box of its own
  if (box.pseudo === 'first-letter' || !box.parent) return false;
  if (drawsAgainstViewport(box)) return false;
  // one turned out of the plane, or moved or scaled in depth, goes on a
  // layer of the window's, whose matrix carries the perspective it is seen
  // in: inside another part's, it would be seen in the other's plane,
  // which a perspective outside it does not move with
  if (within && outOfPlane(box.style)) return false;
  if (box.style.clipPath || masked(box.style)) return false;
  // a filter's colour functions are run over the box's pixels as the
  // document draws them (`paintFiltered`), which a layer does not do
  if (box.style.filter !== null) return false;
  // and what is behind a backdrop filter is filtered as the document draws
  // it, which moves under a layer
  if (box.style.backdropFilter !== null) return false;
  // one fixed to the viewport in it is drawn where the viewport is, which
  // a layer the document scrolls does not follow
  if (!drawnAtViewport(box)) {
    for (const fixed of FIXED_BOXES.get(host.tree) ?? NO_BOXES) {
      if (holds(box, fixed)) return false;
    }
  }
  // up to the box whose layer its own goes in, which carries its fade, its
  // turn and its animation, and was asked about the rest
  for (let at: Box | null = box.parent; at && at !== within; at = at.parent) {
    const style = at.style;
    // a `perspective` turns nothing in the plane, and the one a box out of
    // it is seen in is in its layer's matrix (`solidFrames`)
    if (
      style.opacity < 1 ||
      style.transform !== null ||
      style.translate !== null ||
      style.rotate !== null ||
      style.scale !== null
    ) {
      return false;
    }
    // a box that clips it cuts its layer to a rectangle (`clipFor`), which a
    // path or a mask is not
    if (style.clipPath || masked(style) || style.filter !== null) {
      return false;
    }
    // its own: a pseudo-element's beside the box is no ancestor of it
    if (at.el && host.timeline.isLive(at.el, '')) return false;
  }
  return true;
}

/** `rect` through `m` about `origin`: the bounds of its corners, which
 *  for a matrix out of the plane are where the perspective puts them — or
 *  null, where a corner is behind the viewer. */
function mapRect(
  rect: Rect,
  m: LayerMatrix,
  ox: number,
  oy: number,
): Rect | null {
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
    let x: number;
    let y: number;
    if (m.length === 16) {
      const w = m[3] * dx + m[7] * dy + m[15];
      if (!(w > W_NEAR)) return null;
      x = (m[0] * dx + m[4] * dy + m[12]) / w + ox;
      y = (m[1] * dx + m[5] * dy + m[13]) / w + oy;
    } else {
      x = m[0] * dx + m[2] * dy + m[4] + ox;
      y = m[1] * dx + m[3] * dy + m[5] + oy;
    }
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The overlap of two rects, or null where they have none. */
function meet(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
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
 * cannot tell. A subtree whose ink misses the extent is passed over whole,
 * and one whose ink meets it is looked into rather than taken at its word:
 * a subtree's ink is the union of all it holds, and CodeMirror parks an
 * element ten thousand pixels above an editor while Docusaurus keeps its
 * menu's backdrop over the whole viewport, hidden, so the ink of a
 * playground's editor and of its navbar met the frame beside them. So
 * what counts is a box's own ink, where it is visible; nothing under an
 * opacity of 0; and nothing a box that clips what it holds cuts away from
 * the extent. A box's own ink is its border box with its shadows and its
 * outline; one with no rectangle of its own, an inline box, is taken at
 * its ink, as before.
 */
export function crowded(tree: BoxTree, box: Box, extent: Rect): boolean {
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
    if (!overlaps(ink, extent)) continue;
    const style = at.style;
    // nothing it or what it holds draws shows
    if (drawsNothing(at)) continue;
    // taken at its ink: an inline box, whose rect no layout sets, and a box
    // drawn through a matrix or a filter, whose rect is not where it draws
    if (!hasRect(at) || placedMatrix(at) || style.filter !== null) return true;
    // its own: the border box, and the shadows and the outline past it
    if (style.visibility === 'visible') {
      let { x, y, width, height } = at;
      if (style.boxShadow) {
        const out = shadowOutsets(style.boxShadow);
        x -= out.left;
        y -= out.top;
        width += out.left + out.right;
        height += out.top + out.bottom;
      }
      if (style.outlineStyle !== 'none' && style.outlineWidth > 0) {
        const grow = Math.max(0, style.outlineOffset + style.outlineWidth);
        x -= grow;
        y -= grow;
        width += 2 * grow;
        height += 2 * grow;
      }
      if (overlaps({ x, y, width, height }, extent)) return true;
    }
    // what it holds, where a box that clips it leaves it within reach
    if (
      clipsOverflow(at) &&
      style.overflowX !== 'visible' &&
      style.overflowY !== 'visible' &&
      !overlaps(
        {
          x: at.x + at.borderLeft,
          y: at.y + at.borderTop,
          width: at.width - at.borderLeft - at.borderRight,
          height: at.height - at.borderTop - at.borderBottom,
        },
        extent,
      )
    ) {
      continue;
    }
    for (const child of at.children) stack.push(child);
  }
  return false;
}

/** A frame's transform as sampled: a matrix of the plane, or the whole
 *  4×4 of one out of it (`matrix4Of`), without the perspective it is seen
 *  in, which the part's place decides (`solidFrames`). */
type SampledMatrix = SpriteMatrix | Mat4;

/** The style of a lift's element, or of its pseudo-element, with no
 *  animation and no transition running: what its frames are sampled from
 *  but the time. */
function still(
  host: SpriteHost,
  parentStyle: ComputedStyle,
  inFlex: boolean,
  lift: Lift,
): ComputedStyle {
  const { el, box } = lift;
  const cascade = host.cascade;
  const was = cascade.timeline;
  cascade.timeline = null;
  try {
    return lift.pseudo
      ? (cascade.pseudoStyleFor(el, lift.pseudo, parentStyle) ?? box.style)
      : cascade.styleFor(el, parentStyle, inFlex);
  } finally {
    cascade.timeline = was;
  }
}

/** Each track's frames through one cycle of it, sampled from the
 *  element's style on a fork of the document's timeline — its opacities
 *  where it sets the opacity, its matrices where it moves — the style the
 *  animations leave at rest, and whether a frame takes it out of the
 *  plane, or the rest does, which a layer then carries as a `matrix3d()`.
 *  A still part's is no frame and its own style. */
function sample(
  host: SpriteHost,
  parentStyle: ComputedStyle,
  inFlex: boolean,
  lift: Lift,
): {
  frames: { opacities: number[]; matrices: SampledMatrix[] }[];
  rest: ComputedStyle;
  solid: boolean;
} {
  const { el, box } = lift;
  const cascade = host.cascade;
  const was = cascade.timeline;
  const pseudo = lift.pseudo;
  // On a fork of the document's timeline for each track, asked in the
  // order of its times: a transition a fork has run to its end is over
  // there from then on, as it is on the document's, and a track that
  // begins before that end would find it over.
  const at = (fork: AnimationTimeline, time: number): ComputedStyle => {
    fork.now = time;
    cascade.timeline = fork;
    // a pseudo-element's inherits from its element's, which `parentStyle`
    // is for one
    return pseudo
      ? (cascade.pseudoStyleFor(el, pseudo, parentStyle) ?? box.style)
      : cascade.styleFor(el, parentStyle, inFlex);
  };
  let solid = false;
  try {
    // a track's property is its alone (`liftOf`), so the style at a time
    // in its cycle says what it is there, whatever the others are at
    const frames = lift.tracks.map((track) => {
      const fork = host.timeline.fork(el);
      const opacities: number[] = [];
      const matrices: SampledMatrix[] = [];
      const n = Math.max(
        2,
        Math.min(MAX_SAMPLES, Math.round(track.cycle / SAMPLE_MS)),
      );
      for (let k = 0; k <= n; k += 1) {
        // the last frame a breath short of the cycle's end, which is the
        // next one's start
        const u = k === n ? track.cycle - 1e-3 : (k / n) * track.cycle;
        const style = at(fork, track.begin + u);
        if (track.opacity) {
          opacities.push(Math.min(1, Math.max(0, style.opacity)));
        }
        if (track.transform) {
          const turned = matrix4Of(style, box.width, box.height);
          solid ||= turned !== null;
          matrices.push(
            turned ??
              ([...matrixOf(style, box.width, box.height)] as SpriteMatrix),
          );
        }
      }
      return { opacities, matrices };
    });
    // past the last end, as each fill mode leaves its property and each
    // transition its end; a loop never gets there, and its property rests
    // wherever it is
    let end = -Infinity;
    for (const track of lift.tracks) {
      if (track.end !== Infinity) end = Math.max(end, track.end);
    }
    const rest =
      end === -Infinity ? box.style : at(host.timeline.fork(el), end + 1);
    return { frames, rest, solid: solid || outOfPlane(rest) };
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
  /** The translation layout moved the box by, and the boxes of the parts
   *  whose layers its own is in: undone when it is painted on its layer,
   *  whose matrix carries each frame's of its own, and its parents' theirs.
   *  The space its `rect`, `origin` and `clip` are in. */
  translation: [number, number];
  opacity: number;
  transform: LayerMatrix;
  animations: DocumentSpriteAnimation[];
  /** When each of `animations` began its active phase, on the document's
   *  clock: its delay, made each frame from now (`describe`). */
  begins: number[];
  /** Where the boxes around it let it show (`clipFor`), in the document's
   *  coordinates; null where nothing cuts it. */
  clip: Rect | null;
  /** The radius of the clip's corners, where a box with round corners cuts
   *  it (`clipFor`): 0 for a square clip. */
  clipRadius: number;
  /** What shows of everywhere it can be while it runs, in the document's
   *  coordinates. */
  extent: Rect;
  /** The boxes fixed to the viewport, which a scroll moves over the
   *  document: one within `extent` where the viewport has it now covers
   *  the element there, or ought to (`HtmlViewNode.sprites`). */
  fixed: readonly Box[];
  /** Whether it is drawn where the viewport is (`drawnAtViewport`), as a
   *  toast or a banner fixed to it is: its layer stays there as the pane
   *  scrolls the document under it, from the viewport's corner. */
  atViewport: boolean;
  /** Its frames as sampled, kept by what they are sampled from. */
  sampled: Sampled;
  /** Where nothing painted after it may reach, in the document's
   *  coordinates — what shows of it, and the whole document where the
   *  scroll takes it over all of it — and what shows of it for a box fixed
   *  to the viewport, which keeps its place against it: asked by
   *  `coveredAfter`, every frame, of what is painted after it then. */
  over: Rect;
  fixedOver: Rect | null;
}

/** A part's frames as sampled, and what they are sampled from: its
 *  style, the style that inherits into it and its animations, with the
 *  size of its box (`Lift.id`). The same while those are, so a box inside
 *  it that changes, which paints its layer again, samples nothing — a
 *  spinner turning in a card that pulses would otherwise sample the card's
 *  whole cycle at every frame of the spinner's — and nor does a build that
 *  keeps its style, though its boxes are new: Zen Garden 219's marquees
 *  build the document at every frame. */
interface Sampled {
  id: string;
  style: ComputedStyle;
  parent: ComputedStyle;
  /** The style with no animation running, and the cascade it is of: what
   *  the frames are sampled from but the animations' time (`still`). */
  base: ComputedStyle;
  cascade: object;
  frames: { opacities: number[]; matrices: SampledMatrix[] }[];
  rest: ComputedStyle;
  /** Whether a frame, or the rest, is out of the plane. */
  solid: boolean;
  /** Where it is: its frames as its layer takes them, and what they were
   *  made for (`solidFrames`). */
  layer?: { key: string; frames: SolidFrames };
}

/** The matrices of a part out of the plane, as its layer takes them: where
 *  it rests, and each track's frames — a fade's none. */
interface SolidFrames {
  rest: SpriteMatrix3D;
  tracks: SpriteMatrix3D[][];
}

/**
 * A part's matrices out of the plane, as its layer takes them: each the
 * 4×4 of a frame, about the depth of the transform origin, seen in the
 * perspective the document sees the box in (`perspectiveAround`) — all
 * about (`ox`, `oy`), the point the layer turns about, where the document
 * has the origin with no transform. A frame of the plane is one of space
 * with nothing out of it. Null where the box shows its back with
 * `backface-visibility: hidden`, at rest or on the way, which the document
 * leaves undrawn and a layer would draw. Kept by the sampling, for as long
 * as the perspective is where it was.
 */
function solidFrames(
  sampled: Sampled,
  box: Box,
  ox: number,
  oy: number,
): SolidFrames | null {
  const style = box.style;
  const oz = style.transformOriginZ;
  const around = perspectiveAround(box);
  // the perspective about the layer's origin: T(-o) · P · T(o)
  const seen =
    around &&
    multiply4(
      translate4(-ox, -oy, 0),
      multiply4(around, translate4(ox, oy, 0)),
    );
  const key = `${oz}:${seen ? seen.join(',') : ''}`;
  if (sampled.layer?.key === key) return sampled.layer.frames;
  const hidden = style.backfaceVisibility === 'hidden';
  let away = false;
  const toLayer = (m: SampledMatrix): SpriteMatrix3D => {
    let m4: Mat4 = m.length === 6 ? lift4(m as Matrix) : m;
    if (oz) {
      m4 = multiply4(
        translate4(0, 0, oz),
        multiply4(m4, translate4(0, 0, -oz)),
      );
    }
    const out = seen ? multiply4(seen, m4) : [...m4];
    away ||= hidden && facesAway(out);
    return out as unknown as SpriteMatrix3D;
  };
  const rest = sampled.rest;
  const frames: SolidFrames = {
    rest: toLayer(
      matrix4Of(rest, box.width, box.height) ??
        ([...matrixOf(rest, box.width, box.height)] as SpriteMatrix),
    ),
    tracks: sampled.frames.map(({ matrices }) => matrices.map(toLayer)),
  };
  if (away) return null;
  sampled.layer = { key, frames };
  return frames;
}

/**
 * The part `lift` is, or null where the element cannot be one: in a box a
 * layer cannot draw (`liftableBox`), too large, showing nothing, or turned
 * out of the plane so that a corner goes behind the viewer, or its hidden
 * back faces them (`solidFrames`). What
 * the document paints after it is asked every frame, apart
 * (`coveredAfter`), since what is offered with it changes what that is.
 * Its frames are `was`'s where they were sampled from what they would be
 * now. Inside
 * `parent`, where it is given: its layer goes in that part's, so the boxes
 * from its own up to the parent's are all that is asked about, and it is
 * placed with the parent untransformed.
 */
export function partOf(
  host: SpriteHost,
  lift: Lift,
  was: Part | null = null,
  parent: Part | null = null,
): Part | null {
  const { el, box } = lift;
  const tree = host.tree;
  const kept = tree.styles.get(el);
  const within = parent?.lift.box ?? null;
  if (!kept || !liftableBox(host, box, within)) return null;
  // in a layer that stays where the viewport is, or not, as its parent is
  const atViewport = drawnAtViewport(box);
  if (parent && parent.atViewport !== atViewport) return null;
  // the space its parent's raster is drawn in, the document's where it has
  // none: layout moved the boxes inside a part by the part's translation
  const [px, py] = parent?.translation ?? [0, 0];
  const up = isElement(el.parent) ? el.parent : null;
  // what its style is made from at another time: a pseudo-element's from
  // its element's, an element's from its parent's
  const parentStyle = lift.pseudo
    ? kept.style
    : up
      ? tree.styles.get(up)?.style
      : tree.root.style;
  if (!parentStyle) return null;
  // Where the box would be with no transform: layout moved it by the
  // translation its style has now (`applyRelativeOffsets`), and a layer's
  // matrix carries every frame's.
  const now = matrixOf(box.style, box.width, box.height);
  const bx = box.x - now[4] - px;
  const by = box.y - now[5] - py;
  const own = ownBounds(box);
  const reach = {
    x: own.x - now[4] - px,
    y: own.y - now[5] - py,
    width: own.width,
    height: own.height,
  };
  if (reach.width > MAX_SIDE || reach.height > MAX_SIDE) return null;
  // the frames sampled before, where they are of the same animations of
  // the same style, inheriting the same: a build that kept the element's
  // style keeps them, though its boxes are new (`Lift.id` has the box's
  // size, which a percentage is of)
  // A style a build made again for the root box, which is no element's,
  // is compared by what it holds; and one made again for the element, by
  // what it holds with no animation running, since the animations' own
  // fields are at another time in it: Zen Garden 214's h1::before, which
  // grows over 36000 s, sampled the 600 frames of its cycle again at every
  // breakpoint a resize crossed, which styled the h1 again the same.
  const known = was?.sampled;
  let base: ComputedStyle | null = null;
  const alike =
    !!known &&
    known.id === lift.id &&
    known.cascade === host.cascade &&
    (known.parent === parentStyle || sameValue(known.parent, parentStyle)) &&
    (known.style === box.style ||
      sameValue(
        known.base,
        (base = still(host, parentStyle, kept.inFlex, lift)),
      ));
  const sampled: Sampled = alike
    ? known!.style === box.style
      ? known!
      : {
          ...known!,
          style: box.style,
          parent: parentStyle,
          // a loop's rest is the style it has, wherever it is
          rest: known!.rest === known!.style ? box.style : known!.rest,
        }
    : {
        id: lift.id,
        style: box.style,
        parent: parentStyle,
        base: base ?? still(host, parentStyle, kept.inFlex, lift),
        cascade: host.cascade,
        ...sample(host, parentStyle, kept.inFlex, lift),
      };
  const { frames, rest } = sampled;
  const origin = box.style.transformOrigin;
  const ox = bx + resolve(origin[0], box.width, 0);
  const oy = by + resolve(origin[1], box.height, 0);
  // the layer's matrices: of the plane, as sampled, or out of it, each seen
  // in the perspective the document sees the box in
  let transform: LayerMatrix;
  let turns: LayerMatrix[][];
  if (sampled.solid) {
    const solid = solidFrames(sampled, box, ox, oy);
    if (!solid) return null;
    transform = solid.rest;
    turns = solid.tracks;
  } else {
    transform = [...matrixOf(rest, box.width, box.height)] as SpriteMatrix;
    turns = frames.map(({ matrices }) => matrices as SpriteMatrix[]);
  }
  // everywhere it can be: its reach where it rests, and through every frame
  // — none of it behind the viewer, which only the document can cut
  let extent = mapRect(reach, transform, ox, oy);
  for (const matrices of turns) {
    for (const m of matrices) {
      if (!extent) break;
      const at = mapRect(reach, m, ox, oy);
      extent = at && unionRect(extent, at);
    }
  }
  if (!extent) return null;
  // the boxes that clip it cut its layer — up to its parent's, which cut
  // that part's — and what shows of it is all that anything painted after
  // it could cover. The document's own boxes are where layout put them,
  // its parents' translations and all.
  const toDocument = (r: Rect): Rect => ({
    x: r.x + px,
    y: r.y + py,
    width: r.width,
    height: r.height,
  });
  const cut = clipFor(box, toDocument(extent), host.scale, within);
  if (cut === null) return null;
  const clip = cut && {
    x: cut.rect.x - px,
    y: cut.rect.y - py,
    width: cut.rect.width,
    height: cut.rect.height,
  };
  const shows = clip ? meet(extent, clip) : extent;
  if (!shows) return null;
  // What is painted before it is under the layer as it is under it, and
  // what is painted after it must not be. One at the viewport keeps its
  // place against what is fixed there, and the scroll takes it anywhere
  // over the rest of the document.
  const showsHere = toDocument(shows);
  const over =
    atViewport && host.scrolls
      ? unionRect(showsHere, inkOf(tree.root))
      : showsHere;
  const animations: DocumentSpriteAnimation[] = [];
  const begins: number[] = [];
  lift.tracks.forEach((track, i) => {
    const repeat = track.repeat;
    const { opacities } = frames[i];
    if (track.opacity) {
      animations.push({
        id: `${track.id}|opacity`,
        property: 'opacity',
        values: opacities,
        duration: track.cycle,
        delay: 0,
        repeat,
      });
      begins.push(track.begin);
    }
    if (track.transform) {
      animations.push({
        id: `${track.id}|transform`,
        property: 'transform',
        values: turns[i],
        duration: track.cycle,
        delay: 0,
        repeat,
      });
      begins.push(track.begin);
    }
  });
  return {
    lift,
    rect: { x: bx, y: by, width: box.width, height: box.height },
    reach,
    origin: { x: ox, y: oy },
    translation: [now[4] + px, now[5] + py],
    opacity: Math.min(1, Math.max(0, rest.opacity)),
    transform,
    animations,
    begins,
    clip: clip ?? null,
    clipRadius: cut?.radius ?? 0,
    extent: shows,
    // asked of a part in the document's layer alone: one inside another's
    // goes where the other does
    fixed: parent ? NO_BOXES : (FIXED_BOXES.get(tree) ?? NO_BOXES),
    atViewport,
    sampled,
    over,
    fixedOver: atViewport ? showsHere : null,
  };
}

/**
 * Whether the document paints anything after `part` that reaches where it
 * shows (`paintedAfter`) — where that cannot be told, any ink but its own
 * and its ancestors' (`crowded`) — but for the boxes in `above`: parts
 * offered with it and painted after it, whose layers stand over its own.
 * The presenter keeps that word, taking `part` off its layer in the frame
 * it turns one of those down (react-x11's `Node.sprites()`).
 */
export function coveredAfter(
  tree: BoxTree,
  part: Part,
  above: ReadonlySet<Box> | null = null,
): boolean {
  const box = part.lift.box;
  return (
    paintedAfter(box, part.over, part.fixedOver, above) ??
    crowded(tree, box, part.over)
  );
}

/** Everywhere a box and what it holds put ink. */
function inkOf(box: Box): Rect {
  return {
    x: box.boundsX,
    y: box.boundsY,
    width: box.boundsWidth,
    height: box.boundsHeight,
  };
}

const NO_BOXES: readonly Box[] = [];

/**
 * The sprite a part is this frame: in the window's coordinates, with the
 * document's origin at (`originX`, `originY`), its animations' delays
 * counted from `now` — what the presenter reads when it attaches one — and
 * painted by `paint`, which draws a box as the document would, but for the
 * parts the presenter lifted inside it (`children`, their keys). `parent`
 * is the key of the part whose layer this one's goes in, where it is in
 * one (`partOf`).
 */
export function describe(
  part: Part,
  key: string,
  version: string,
  originX: number,
  originY: number,
  now: number,
  paint: (ctx: Context2D, box: Box, children?: ReadonlySet<string>) => void,
  parent: string | null = null,
): DocumentSprite {
  const shift = (r: Rect): Rect => ({
    x: r.x + originX,
    y: r.y + originY,
    width: r.width,
    height: r.height,
  });
  const [tx, ty] = part.translation;
  const box = part.lift.box;
  return {
    key,
    ...(parent !== null ? { parent } : null),
    rect: shift(part.rect),
    reach: shift(part.reach),
    version,
    paint(ctx: Context2D, children?: ReadonlySet<string>) {
      ctx.save();
      try {
        // drawn where it would be with no transform: the layer's matrix
        // puts it where each frame has it, and its parents' theirs
        ctx.translate(-tx, -ty);
        paint(ctx, box, children);
      } finally {
        ctx.restore();
      }
    },
    ...(part.clip ? { clip: shift(part.clip) } : null),
    ...(part.clip && part.clipRadius ? { clipRadius: part.clipRadius } : null),
    opacity: part.opacity,
    transform: part.transform,
    origin: { x: part.origin.x + originX, y: part.origin.y + originY },
    animations: part.animations.map((a, i) => ({
      ...a,
      delay: part.begins[i] - now,
    })),
  };
}

// --- shadows ----------------------------------------------------------------
//
// A box whose outer `box-shadow` is in transition is offered as a part that
// is its shadows alone (react-x11's `Sprite.shadows`): the render server
// draws and blurs them on the GPU, from frames sampled as an animation's
// are, while the box itself stays the document's — its border, its colour
// and whatever it holds change on the document's clock as they did. What
// that saves is the shadows, which the document blurred a pixel at a time
// over all of their reach at every frame: a card on the Zen Garden's
// all-designs page brings in glows of 200, 100 and 6px as it is hovered,
// and on macOS at 2x most of each frame was those, drawn over everything
// under them. The document leaves the box's outer shadows out of its paint
// and out of what a frame of the box repaints (`PaintOptions.shadowless`).
//
// A box is offered where its shadows are all a layer can show of them: a
// box in the plane, with its corners one circle each, the same through
// every frame and its spreads too, none of them inset, no outline, nothing
// of it or what it holds drawn past its border box — under which none of
// its shadow is drawn, and where the layer's mask leaves the document's
// pixels — and inside nothing that fades, turns or masks. And nothing the
// document paints after it reaches where its shadows do.

/** A part that is a box's shadows, as react-x11's `Node.sprites()` takes
 *  one: no `paint`, its shadows' and its transform's frames for the render
 *  server. */
export interface DocumentShadowSprite extends Sprite {
  shadows: SpriteShadow[];
  rectRadius: number;
  opacity: number;
  transform: SpriteMatrix;
  origin: { x: number; y: number };
  animations: DocumentSpriteAnimation[];
}

/** The fields of a style a transform is made of. */
const TRANSFORMS = new Set(['transform', 'translate', 'rotate', 'scale']);

/** An element whose outer shadows are in transition: from its transitions'
 *  first start to their last end, on the document's clock. */
export interface ShadowLift {
  el: Element;
  box: Box;
  begin: number;
  cycle: number;
  /** What its frames are sampled from; its animations' ids start with it. */
  id: string;
}

/**
 * The element's shadows in transition, where a part can carry them, or
 * null: its `box-shadow` under way, and with it no fade and no animation
 * of the element's own, and no transition of what a transform is made of
 * but its four fields, which the part's layer runs with the shadows. Cheap,
 * and asked every frame; the frames are sampled once (`shadowPartOf`).
 */
export function shadowLiftOf(host: SpriteHost, el: Element): ShadowLift | null {
  const box = host.boxes.get(el);
  const style = host.tree.styles.get(el)?.style;
  if (!style || !box || box.el !== el) return null;
  // its own animations are the document's, or a layer's (`liftOf`)
  if (style.animations.names.some((name) => name !== null)) return null;
  const transits = host.timeline.transitsOf(el, '');
  if (!transits) return null;
  let shadows = false;
  let begin = Infinity;
  let end = -Infinity;
  const serials: number[] = [];
  for (const [field, run] of transits) {
    if (host.now >= run.start + run.duration || !(run.duration > 0)) continue;
    if (field === 'boxShadow') shadows = true;
    // a fade fades the shadows with the box, and a moving origin moves
    // them, neither of which the part's layer is told
    else if (field === 'opacity' || field === 'transformOrigin') return null;
    // anything else the box draws the document draws
    else if (!TRANSFORMS.has(field)) continue;
    begin = Math.min(begin, run.start);
    end = Math.max(end, run.start + run.duration);
    serials.push(run.serial);
  }
  if (!shadows) return null;
  const id = ['shadows', ...serials, box.width, box.height].join('|');
  if (host.ended(el, id)) return null;
  return { el, box, begin, cycle: end - begin, id };
}

/** A box's shadows as a part, in the document's coordinates, untranslated
 *  as a `Part` is (`partOf`). */
export interface ShadowPart {
  lift: ShadowLift;
  /** The border box with no transform. */
  rect: Rect;
  radius: number;
  /** Each where its transition leaves it. */
  shadows: SpriteShadow[];
  origin: { x: number; y: number };
  translation: [number, number];
  transform: SpriteMatrix;
  animations: DocumentSpriteAnimation[];
  begins: number[];
  clip: Rect | null;
  clipRadius: number;
  /** Where the shadows can be while they run, in the document's
   *  coordinates: what nothing painted after the box may reach. */
  over: Rect;
  /** What the frames are sampled from, kept while it is the same. */
  sampled: ShadowSampled;
}

interface ShadowSampled {
  id: string;
  cascade: object;
  parent: ComputedStyle;
  /** Each frame's outer shadows, padded to as many as the most a frame
   *  has, and its transform. */
  shadows: SpriteShadowFrame[][];
  matrices: SpriteMatrix[];
}

interface SpriteShadowFrame {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: SpriteColor;
}

const CLEAR: SpriteColor = [0, 0, 0, 0];

/**
 * The part `lift` is, or null where its shadows cannot be one (`ShadowLift`
 * says what can). Its frames are `was`'s where they were sampled from what
 * they would be now. What the document paints after the box is asked
 * apart, every frame (`shadowsCovered`).
 */
export function shadowPartOf(
  host: SpriteHost,
  lift: ShadowLift,
  was: ShadowPart | null = null,
): ShadowPart | null {
  const { el, box } = lift;
  const tree = host.tree;
  const kept = tree.styles.get(el);
  if (!kept || !liftableBox(host, box) || drawnAtViewport(box)) return null;
  const style = box.style;
  if (style.opacity < 1 || outOfPlane(style)) return null;
  // what it draws besides its shadows stays inside its border box
  if (!keptInside(box)) return null;
  const up = isElement(el.parent) ? el.parent : null;
  const parentStyle = up ? tree.styles.get(up)?.style : tree.root.style;
  if (!parentStyle) return null;
  const w = box.width;
  const h = box.height;
  // one circle at every corner, the same at every frame (`border-radius`
  // is in the style it is sampled from)
  const radius = circleOf(cornersOf(style, w, h));
  if (radius === null) return null;
  const known = was?.sampled;
  let sampled: ShadowSampled | null =
    known &&
    known.id === lift.id &&
    known.cascade === host.cascade &&
    (known.parent === parentStyle || sameValue(known.parent, parentStyle))
      ? known
      : null;
  if (!sampled) {
    sampled = sampleShadows(host, parentStyle, kept.inFlex, lift, radius);
    if (!sampled) return null;
  }
  const frames = sampled.shadows;
  const n = frames[0].length;
  if (!n) return null;
  // where the box would be with no transform: layout moved it by the
  // translation its style has now
  const now = matrixOf(style, w, h);
  const bx = box.x - now[4];
  const by = box.y - now[5];
  const origin = style.transformOrigin;
  const ox = bx + resolve(origin[0], w, 0);
  const oy = by + resolve(origin[1], h, 0);
  const last = frames[frames.length - 1];
  const shadows: SpriteShadow[] = last.map((f) =>
    shadowOf(f, bx, by, w, h, radius),
  );
  // everywhere the shadows can be: each frame's, through its transform
  let reach: Rect | null = null;
  for (let k = 0; k < frames.length; k += 1) {
    let at: Rect | null = null;
    for (const f of frames[k]) {
      const pad = Math.ceil(1.5 * f.blur) + 1;
      at = unionRect(at ?? { x: bx, y: by, width: w, height: h }, {
        x: bx - f.spread + f.x - pad,
        y: by - f.spread + f.y - pad,
        width: w + 2 * (f.spread + pad),
        height: h + 2 * (f.spread + pad),
      });
    }
    const m = sampled.matrices[k];
    const seen = at && mapRect(at, m, ox, oy);
    if (!seen) return null;
    reach = reach ? unionRect(reach, seen) : seen;
  }
  if (!reach) return null;
  if (reach.width > MAX_SIDE || reach.height > MAX_SIDE) return null;
  const cut = clipFor(box, reach, host.scale, null);
  if (cut === null) return null;
  const shows = cut ? meet(reach, cut.rect) : reach;
  if (!shows) return null;
  // the frames as the layer's animations: each shadow's blur, colour and
  // offset where they change, and the transform where it does
  const animations: DocumentSpriteAnimation[] = [];
  const begins: number[] = [];
  const add = (
    property: DocumentSpriteAnimation['property'],
    values: DocumentSpriteAnimation['values'],
    shadow?: number,
  ): void => {
    animations.push({
      id: `${lift.id}|${property}${shadow ?? ''}`,
      property,
      ...(shadow !== undefined ? { shadow } : null),
      values,
      duration: lift.cycle,
      delay: 0,
      repeat: 1,
    });
    begins.push(lift.begin);
  };
  for (let i = 0; i < n; i += 1) {
    const blurs = frames.map((f) => f[i].blur);
    if (varies(blurs)) add('shadowBlur', blurs, i);
    const colors = frames.map((f) => f[i].color);
    if (colors.some((c) => !sameMatrix(c, colors[0]))) {
      add('shadowColor', colors, i);
    }
    const offsets = frames.map((f) => [f[i].x, f[i].y] as [number, number]);
    if (offsets.some((p) => p[0] !== offsets[0][0] || p[1] !== offsets[0][1])) {
      add('shadowOffset', offsets, i);
    }
  }
  const matrices = sampled.matrices;
  if (matrices.some((m) => !sameMatrix(m, matrices[0]))) {
    add('transform', matrices);
  }
  return {
    lift,
    rect: { x: bx, y: by, width: w, height: h },
    radius,
    shadows,
    origin: { x: ox, y: oy },
    translation: [now[4], now[5]],
    transform: [...matrixOf(style, w, h)] as SpriteMatrix,
    animations,
    begins,
    clip: cut ? cut.rect : null,
    clipRadius: cut?.radius ?? 0,
    over: shows,
    sampled,
  };
}

/** The frames of a box's shadows and its transform through its
 *  transitions, on a fork of the document's timeline; null where a frame
 *  has an inset shadow, an outline, a fade, corners that are not the
 *  circle `radius`, a spread that changes, or a transform out of the
 *  plane. */
function sampleShadows(
  host: SpriteHost,
  parentStyle: ComputedStyle,
  inFlex: boolean,
  lift: ShadowLift,
  radius: number,
): ShadowSampled | null {
  const { el, box } = lift;
  const cascade = host.cascade;
  const was = cascade.timeline;
  const fork = host.timeline.fork(el);
  const lists: SpriteShadowFrame[][] = [];
  const matrices: SpriteMatrix[] = [];
  const n = Math.max(
    2,
    Math.min(MAX_SAMPLES, Math.round(lift.cycle / SAMPLE_MS)),
  );
  try {
    for (let k = 0; k <= n; k += 1) {
      // the last a breath short of the end, where the transitions rest
      const u = k === n ? lift.cycle - 1e-3 : (k / n) * lift.cycle;
      fork.now = lift.begin + u;
      cascade.timeline = fork;
      const style = cascade.styleFor(el, parentStyle, inFlex);
      if (style.opacity < 1 || style.outlineStyle !== 'none') return null;
      if (outOfPlane(style)) return null;
      if (circleOf(cornersOf(style, box.width, box.height)) !== radius) {
        return null;
      }
      const list: SpriteShadowFrame[] = [];
      for (const s of style.boxShadow ?? []) {
        if (s.inset) return null;
        const color = rgbaOf(inkColor(s.color, style.color));
        if (!color) return null;
        list.push({ x: s.x, y: s.y, blur: s.blur, spread: s.spread, color });
      }
      lists.push(list);
      matrices.push([
        ...matrixOf(style, box.width, box.height),
      ] as SpriteMatrix);
    }
  } finally {
    cascade.timeline = was;
  }
  // padded as CSS pads a shorter list to interpolate it: with shadows of
  // nothing in a colour of nothing, which are the frames' own where a
  // transition ran between two lists
  let most = 0;
  for (const list of lists) most = Math.max(most, list.length);
  for (const list of lists) {
    while (list.length < most) {
      list.push({ x: 0, y: 0, blur: 0, spread: 0, color: CLEAR });
    }
  }
  // a shadow's shape is its spread's, which a layer's caster keeps
  for (let i = 0; i < most; i += 1) {
    const spread = lists[0][i].spread;
    if (lists.some((list) => list[i].spread !== spread)) return null;
  }
  return {
    id: lift.id,
    cascade,
    parent: parentStyle,
    shadows: lists,
    matrices,
  };
}

/** A frame's shadow as a part's: its shape the border box spread out, its
 *  corners as a spread rounds them. */
function shadowOf(
  f: SpriteShadowFrame,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): SpriteShadow {
  const s = f.spread;
  const corners = radius
    ? spreadCorners(
        {
          x: [radius, radius, radius, radius],
          y: [radius, radius, radius, radius],
        },
        w,
        h,
        s,
        s,
        s,
        s,
      )
    : null;
  return {
    rect: { x: x - s, y: y - s, width: w + 2 * s, height: h + 2 * s },
    radius: corners ? corners.x[0] : 0,
    x: f.x,
    y: f.y,
    blur: f.blur,
    color: f.color,
  };
}

/** The radius of corners that are one circle each, all four alike; 0 for
 *  square ones, and null for any other. */
function circleOf(c: { x: number[]; y: number[] } | null): number | null {
  if (!c) return 0;
  const r = c.x[0];
  for (let i = 0; i < 4; i += 1) {
    if (c.x[i] !== r || c.y[i] !== r) return null;
  }
  return r;
}

/** Whether a box draws nothing past its border box but its shadows: it
 *  clips what it holds, or what it holds is all inside it. */
function keptInside(box: Box): boolean {
  const style = box.style;
  if (style.outlineStyle !== 'none') return false;
  const clips = style.overflowX !== 'visible' && style.overflowY !== 'visible';
  if (clips) return true;
  const x1 = box.x + box.width;
  const y1 = box.y + box.height;
  for (const child of box.children) {
    if (
      child.boundsX < box.x ||
      child.boundsY < box.y ||
      child.boundsX + child.boundsWidth > x1 ||
      child.boundsY + child.boundsHeight > y1
    ) {
      return false;
    }
  }
  for (const line of box.lines ?? []) {
    if (
      line.x < box.x ||
      line.y < box.y ||
      line.x + line.width > x1 ||
      line.y + line.height > y1
    ) {
      return false;
    }
  }
  return true;
}

const varies = (values: number[]): boolean =>
  values.some((v) => v !== values[0]);

const sameMatrix = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Whether the document paints anything after the box whose shadows `part`
 * is that reaches where they can be (`paintedAfter`) — where that cannot be
 * told, any ink but the box's own and its ancestors' (`crowded`) — but for
 * the boxes in `above`, parts offered with it and painted after it.
 */
export function shadowsCovered(
  tree: BoxTree,
  part: ShadowPart,
  above: ReadonlySet<Box> | null = null,
): boolean {
  const box = part.lift.box;
  return (
    paintedAfter(box, part.over, null, above) ?? crowded(tree, box, part.over)
  );
}

/** The sprite a box's shadows are this frame, as `describe` makes one of a
 *  `Part`: in the window's coordinates, with the document's origin at
 *  (`originX`, `originY`), its animations' delays counted from `now`. */
export function describeShadows(
  part: ShadowPart,
  key: string,
  originX: number,
  originY: number,
  now: number,
): DocumentShadowSprite {
  const shift = (r: Rect): Rect => ({
    x: r.x + originX,
    y: r.y + originY,
    width: r.width,
    height: r.height,
  });
  return {
    key,
    rect: shift(part.rect),
    rectRadius: part.radius,
    shadows: part.shadows.map((sh) => ({ ...sh, rect: shift(sh.rect) })),
    ...(part.clip ? { clip: shift(part.clip) } : null),
    ...(part.clip && part.clipRadius ? { clipRadius: part.clipRadius } : null),
    opacity: 1,
    transform: part.transform,
    origin: { x: part.origin.x + originX, y: part.origin.y + originY },
    animations: part.animations.map((a, i) => ({
      ...a,
      delay: part.begins[i] - now,
    })),
  };
}
