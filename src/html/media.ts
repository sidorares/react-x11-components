// `<video>`: where a player goes, and what it plays.
//
// A video in a document is **not drawn here**, any more than a form control
// is. It is core's `<video>` (react-x11 2.33.0), mounted beside the element
// at the rectangle layout gave the video's content box — the posture
// `controls.ts` set for a control, and for the same reason: a drawn video is
// a picture of a video. Core's element plays a `src` with the platform's
// player where there is one (AVFoundation on macOS), shows frames a host
// decodes on every backend, goes on a layer of its own on macOS when nothing
// is over it, and is drawn into the window when something is. None of that
// is this component's to write again (core's `docs/architecture/video.md`,
// 8.2).
//
// The document still lays the box out and paints what it always painted —
// its background, its border and its poster — and the player goes over the
// poster: transparent until it has a frame, and then the picture. Its size
// becomes the video's once the player knows it (`HtmlViewNode.mediaLoaded`),
// so the poster under a playing video is drawn at the picture's ratio,
// exactly under it.
//
// What decides whether a player is mounted at all is what a sibling mounted
// over the document can and cannot be:
//
//  - **What the document paints after the video is painted over it
//    again.** A player is above the whole document, so a caption laid
//    across a video, a play button in its corner or a gradient on top of a
//    hero would be hidden under it. A few such boxes (`MAX_COVERS`), each
//    where a rectangle stands for what clips it, are painted a second time,
//    over the player, by a sibling mounted after it, as the document paints
//    them — through their own matrix, opacity and filter (`coversOf`,
//    `HtmlViewNode.paintCovers`, `paintCover`). What is painted after a
//    video in a box's flow is what is painted after the box
//    (`coverersOver`), and what that flow paints over it is no box to paint
//    again. A video with any other over it stays its poster (`crowded`
//    where its place in the paint order cannot be told) — the test a
//    sprite's layer is held to (`sprites.ts`). What is asked of a box is
//    what it draws there, and not how far it reaches (`inkMeets`): GitHub
//    lays an empty box over its hero's video, and its header holds a menu,
//    hidden, that reaches as far.
//  - **A box fixed to the viewport is asked about as the pane scrolls**
//    (`cutByFixed`): a header that comes over a playing video cuts the
//    player where it reaches it, and one that reaches into its middle hides
//    it, the poster drawn there in the meantime and the video playing on.
//    A sticky box the viewport holds (`VIEWPORT_STICKY`), which the pane's
//    scroll moves over the document as it moves a fixed one, is painted
//    over a player again where it is held (`coversOf`), and cuts what is
//    mounted for an embedded element as a fixed box does: joshwcomeau.com's
//    header is one, and a playground's frame that scrolled up under it was
//    mounted nowhere. What is mounted for an element in such a box goes
//    with it, in the pass a scroll runs (`MediaRect.held`).
//  - **What a rectangle cannot follow keeps the poster**: a transform that
//    turns, skews, flips or scales one way more than the other, a
//    `clip-path` or a mask on the video or around it, a video fixed to the
//    viewport, and corners of its own, or of a box around it that cuts it,
//    that are not all one circle. A scale the same both ways and a move is
//    a rectangle still (`zoomBetween`): the box and its clips are placed
//    where the matrices draw them, and an embedded element's mount is
//    told the factor (`EmbeddedRect.zoom`) — a slide deck scales its stage
//    to fit the window, and an `<iframe>` on a slide is drawn at the
//    slide's scale.
//
// Nothing is fetched here either. Each source is the host's to answer
// (`ResourceRequest.kind: 'video'`): with a `src` the platform's player
// opens itself, with a `VideoFrames` sink it feeds, or with `null`, which
// keeps the poster. A source the player then fails on is the next one's
// turn, as HTML's `<source>` list goes.
import type { Element } from 'domhandler';

import { covers, shownBy } from './controls.js';
import { attr, isElement, tagOf } from './dom.js';
import type { ComputedStyle } from './css/style.js';
import { masked } from './css/style.js';
import {
  heldBack,
  heldSet,
  heldShift,
  placedMatrix,
  VIEWPORT_STICKY,
} from './layout/block.js';
import type { Box, BoxTree } from './layout/boxes.js';
import {
  clipFor,
  contentCorners,
  coverersOver,
  drawnAtViewport,
  evenScaleOf,
  FIXED_BOXES,
  inkWithin,
  NO_ZOOM,
  paintedAfter,
  paintOrderOf,
  unzoomRect,
  zoomBetween,
  zoomRect,
} from './paint.js';
import type { Zoom } from './paint.js';
import type { AudioSource, VideoSource } from './resources.js';
import { crowded } from './sprites.js';

type Rect = { x: number; y: number; width: number; height: number };

/** One source a `<video>` may play, as its markup gives it. */
export interface VideoCandidate {
  url: string;
  /** Its `<source type>`, where it says one. */
  type?: string;
}

/**
 * Where a player goes, in the element's own coordinate space. Inside the
 * engine (`mediaRectsOf`) device pixels like every box; what `onMedia`
 * reports is the same rect in logical pixels, because it becomes the style
 * of a node.
 */
export interface MediaRect {
  element: Element;
  /** What plays: the host's answer for the source the element chose. */
  source: VideoSource;
  /** That source, as the document wrote it: what a failure is told by. */
  url: string;
  /** The video's content box, which the picture is fitted into. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** How the picture fits it: the element's `object-fit`, `contain` from
   *  the UA sheet. Placed in the middle whatever `object-position` says. */
  fit: ComputedStyle['objectFit'];
  /** The radius of the content box's corners, where they are rounded. */
  radius?: number;
  /**
   * The part of the document the video shows through, where that is not
   * all of its box: what the boxes that clip their overflow around it cut
   * it to, and the boxes fixed to the viewport the scroll has brought over
   * it. With no area, none of it shows, and it plays on unseen.
   */
  clip?: Rect;
  /** The radius of `clip`'s corners, where a box with round corners around
   *  the video is what cuts it. */
  clipRadius?: number;
  /** How opaque it is drawn, where that is less than 1: its own `opacity`
   *  times every ancestor's. */
  opacity?: number;
  /**
   * Set while a box fixed to the viewport reaches into the picture where
   * no rectangle can cut it out: the player is not seen, and the poster
   * under it shows.
   */
  hidden?: boolean;
  /**
   * Where the document paints over the player, in the same space as `x`:
   * around what of the boxes painted after the video reaches the part of
   * it that shows — a play button in its corner. A sibling mounted after
   * the player paints them there again (`HtmlViewNode.paintCovers`).
   */
  over?: Rect;
  /**
   * Set on a video in a sticky box the viewport keeps: the rect, its
   * `clip` and its `over` are where the flow has it, and the player goes
   * with the box (`ControlRect.held`).
   */
  held?: true;
  /** HTML's attributes, as the element has them — but `muted`, which is
   *  what a script set where one did (`MediaState`). */
  autoPlay: boolean;
  loop: boolean;
  muted: boolean;
  /** Whether the page asked for controls: a press plays and pauses. */
  controls: boolean;
  /** What an assistive technology names it: `aria-label`, or `title`. */
  label?: string;
  /**
   * Whether it plays, where something said — a script's `play()` or
   * `pause()`, or a press on a video with `controls`. Left out, the player
   * plays it from the start where it has `autoplay`, and is still.
   */
  paused?: boolean;
  /** How loud and how fast, where a script set them. */
  volume?: number;
  playbackRate?: number;
  /** Where a script last sought to, in seconds, and how many times it has
   *  sought: a player is sought where the count moved. */
  seek?: { time: number; count: number };
}

/**
 * What a page's script asked of a media element's player
 * (`HtmlHandle.setMediaState`): only the fields it set. `currentTime` is a
 * seek.
 */
export interface MediaState {
  paused?: boolean;
  muted?: boolean;
  volume?: number;
  playbackRate?: number;
  currentTime?: number;
}

/** What is kept of what was asked of a media element's player: the fields
 *  of a `MediaRect` it sets over what the markup says. */
export type MediaAsked = Partial<
  Pick<MediaRect, 'paused' | 'muted' | 'volume' | 'playbackRate' | 'seek'>
>;

/**
 * A player with no picture (`HtmlViewNode._publishSounds`): an `<audio>`
 * a page's script has played, in the document or out of it, and what it
 * plays. Nothing about where it is: it takes no room, and draws nothing.
 */
export interface Sound extends MediaAsked {
  element: Element;
  /** What plays: the host's answer for the source the element chose. */
  source: AudioSource;
  /** That source, as the document wrote it: what a failure is told by. */
  url: string;
  /** The same, resolved against the document's base: the page's
   *  `currentSrc`, which what the player says is told to the page by. */
  key: string;
  loop: boolean;
}

/** What a player with no picture says, as `<Html>` tells it on
 *  (`HtmlViewProps.onMediaEvent`): the item's length, how far it has got,
 *  its end, or a failure. */
export type MediaEventKind = 'metadata' | 'time' | 'ended' | 'error';

/** Told what a player with no picture said: its element, its source
 *  resolved, what it said and a value as a string — the length, or the
 *  time, in seconds, or a failure's message. */
export type MediaEventHandler = (
  element: Element,
  src: string,
  kind: MediaEventKind,
  value: string,
) => void;

/** Whether two lists of sounds say the same: the same elements, in the
 *  same order, playing the same and told the same. */
export function sameSounds(a: Sound[], b: Sound[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.element !== y.element ||
      x.source !== y.source ||
      x.url !== y.url ||
      x.loop !== y.loop ||
      x.paused !== y.paused ||
      x.muted !== y.muted ||
      x.volume !== y.volume ||
      x.playbackRate !== y.playbackRate ||
      x.seek?.count !== y.seek?.count
    ) {
      return false;
    }
  }
  return true;
}

/** What was asked, `state` laid over `was`. */
export function askMedia(
  was: MediaAsked | undefined,
  state: MediaState,
): MediaAsked {
  const next: MediaAsked = { ...was };
  if (state.paused !== undefined) next.paused = state.paused;
  if (state.muted !== undefined) next.muted = state.muted;
  if (state.volume !== undefined) next.volume = state.volume;
  if (state.playbackRate !== undefined) next.playbackRate = state.playbackRate;
  if (state.currentTime !== undefined) {
    next.seek = {
      time: state.currentTime,
      count: (was?.seek?.count ?? 0) + 1,
    };
  }
  return next;
}

/**
 * The sources a `<video>` names, in the order it would try them: its `src`
 * alone where it has one — an empty one is none — and its `<source>`
 * children otherwise, but those whose `media` does not hold (`holds`; HTML
 * 4.8.11.5, the resource selection algorithm). GitHub's heroes name a
 * portrait recording for a phone and a landscape one for anything wider,
 * and a desktop window played the phone's.
 */
export function videoCandidates(
  el: Element,
  holds: (media: string) => boolean,
): VideoCandidate[] {
  const src = attr(el, 'src');
  if (src !== undefined) {
    const url = src.trim();
    return url ? [{ url }] : [];
  }
  const out: VideoCandidate[] = [];
  for (const child of el.children) {
    if (!isElement(child) || tagOf(child) !== 'source') continue;
    const url = (attr(child, 'src') ?? '').trim();
    if (!url) continue;
    const media = attr(child, 'media');
    if (media !== undefined && !holds(media)) continue;
    const type = attr(child, 'type')?.trim();
    out.push(type ? { url, type } : { url });
  }
  return out;
}

/** What a `<video>`'s choice of source is made from, as one string: its
 *  `src`, and each `<source>`'s `src`, `type` and `media`. */
export function videoSignature(el: Element): string {
  let out = attr(el, 'src') ?? '\u0000';
  for (const child of el.children) {
    if (!isElement(child) || tagOf(child) !== 'source') continue;
    out += `\u0001${attr(child, 'src') ?? ''}\u0002${attr(child, 'type') ?? ''}\u0002${attr(child, 'media') ?? '\u0000'}`;
  }
  return out;
}

/**
 * The players a laid-out document mounts: one for each `<video>` that has
 * a box, is visible, has a source the host answered (`sourceOf`), and that
 * a rectangle mounted over the document can show as the document would
 * show it. `scale` is the document's device pixels to a CSS one. The fixed
 * boxes are not asked about here: where they are turns on the scroll
 * (`cutByFixed`).
 */
export function mediaRectsOf(
  tree: BoxTree,
  scale: number,
  sourceOf: (el: Element) => { source: VideoSource; url: string } | null,
  /** Filled with what the document paints over each player (`coversOf`),
   *  by its element. */
  covers: Map<Element, Cover[]>,
): MediaRect[] {
  const out: MediaRect[] = [];
  for (const box of tree.media) {
    const over: Cover[] = [];
    const placed = placementOf(tree, box, scale, over);
    if (!placed) continue;
    const el = placed.element;
    // asked last, and only of what can be mounted: a host is not asked for
    // a video nothing would show
    const chosen = sourceOf(el);
    if (!chosen) continue;
    const label = attr(el, 'aria-label') || attr(el, 'title');
    if (over.length) covers.set(el, over);
    // a picture is fitted into whatever rect it is given: what a scale
    // around it does is in the rect already
    const { zoom: _zoom, heldBy, ...at } = placed;
    const rect: MediaRect = {
      ...at,
      ...(over.length && { over: around(over.map((c) => c.rect)) }),
      source: chosen.source,
      url: chosen.url,
      fit: box.style.objectFit,
      autoPlay: attr(el, 'autoplay') !== undefined,
      loop: attr(el, 'loop') !== undefined,
      muted: attr(el, 'muted') !== undefined,
      controls: attr(el, 'controls') !== undefined,
      ...(label && { label }),
    };
    FIXED_OVER.set(rect, fixedOver(tree, box));
    if (heldBy) HELD_BY.set(rect, heldBy);
    out.push(rect);
  }
  return out;
}

/**
 * Where what a host mounts over an embedded element goes (`renderEmbedded`):
 * an `<iframe>`, a `<canvas>` or an `<embed>`, each a box of its size that
 * the document draws nothing in. Held to what a player is (`placementOf`),
 * since it is a sibling over the document the same way.
 */
export interface EmbeddedRect {
  element: Element;
  /** Which embedded element it is. */
  kind: EmbeddedKind;
  /** Its content box, which what is mounted fills. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** As a player's (`MediaRect`). */
  radius?: number;
  clip?: Rect;
  clipRadius?: number;
  opacity?: number;
  hidden?: boolean;
  /**
   * Set where the element is in a box fixed to the viewport: the rect is
   * where layout put it, at the document's top, and what is mounted goes in
   * a box core keeps where the viewport is (`AT_VIEWPORT`), as a widget's
   * does. A slide deck is fixed over the window.
   */
  atViewport?: true;
  /**
   * Set on an element in a sticky box the viewport keeps: the rect and its
   * `clip` are where the flow has it, and what is mounted goes with the box
   * (`ControlRect.held`). A scale around it keeps it off this, for a sticky
   * offset is in the box's own coordinates, and is told as it is painted.
   */
  held?: true;
  /**
   * The scale the element is drawn at, where the boxes around it, or the
   * element itself, are drawn through one — the same across as down, with
   * no turn or skew (`zoomBetween`). The rect is where it is drawn, so
   * what is mounted there is laid out at the rect's size over this and
   * drawn at this: core's `scale` on the box it is mounted in, which an
   * `<iframe>`'s document is laid out at its CSS size under.
   */
  zoom?: number;
}

export type EmbeddedKind = 'iframe' | 'canvas' | 'embed';

/** The embedded elements a laid-out document mounts what a host gives
 *  over, as `mediaRectsOf` mounts players. */
export function embeddedRectsOf(tree: BoxTree, scale: number): EmbeddedRect[] {
  const out: EmbeddedRect[] = [];
  for (const box of tree.embedded) {
    const placed = placementOf(tree, box, scale, null, true);
    if (!placed) continue;
    const { heldBy, ...at } = placed;
    const rect = { ...at, kind: tagOf(placed.element) as EmbeddedKind };
    FIXED_OVER.set(rect, fixedOver(tree, box));
    HELD_OVER.set(rect, heldOver(tree, box));
    if (heldBy) HELD_BY.set(rect, heldBy);
    out.push(rect);
  }
  return out;
}

/** What a scroll can bring over each laid-out rect: the boxes fixed to the
 *  viewport the document paints after its element (`fixedOver`), which the
 *  rect is cut by where the scroll has them (`cutByFixed`). */
export const FIXED_OVER = new WeakMap<EmbeddedRect | MediaRect, Box[]>();

/** And the sticky boxes the viewport holds that the document paints after
 *  each embedded element (`heldOver`), which its rect is cut by where the
 *  pane's scroll has put them (`cutByFixed`'s `held`). */
export const HELD_OVER = new WeakMap<EmbeddedRect, readonly Box[]>();

/** How far the sticky boxes the viewport keeps hold each laid-out rect from
 *  where the flow has it (`heldShift`), for what is told of it to leave out
 *  once it has been cut where the boxes are now (`MediaRect.held`). */
export const HELD_BY = new WeakMap<
  EmbeddedRect | MediaRect,
  { x: number; y: number }
>();

/**
 * The boxes fixed to the viewport that the document paints after `box`: a
 * scroll can bring one over what is mounted for it, where one painted
 * before it is under it wherever the scroll has it. joshwcomeau.com's
 * floating like button is fixed beside its article, before a playground's
 * frame in the tree, so Chrome paints the frame over it; taken for a box
 * over the frame, inside its rect where no rectangle cuts it out, it hid
 * the frame whole. Where either's place in the paint order cannot be told
 * (`paintOrderOf`), or one is in the other's stacking context, it counts.
 */
function fixedOver(tree: BoxTree, box: Box): Box[] {
  const fixed = FIXED_BOXES.get(tree);
  if (!fixed?.length) return [];
  return paintedAfterOf(fixed, box);
}

/** The sticky boxes the viewport holds that the document paints after
 *  `box`, as `fixedOver` finds the fixed ones: but for one around it,
 *  which it is in and not under. */
function heldOver(tree: BoxTree, box: Box): readonly Box[] {
  const held = VIEWPORT_STICKY.get(tree);
  if (!held?.length) return NO_BOXES;
  const around = held.filter((h) => !holds(h, box));
  return around.length ? paintedAfterOf(around, box) : NO_BOXES;
}

/** Of `boxes`, those painted after `box`: each where either's place in the
 *  paint order cannot be told (`paintOrderOf`), or one is in the other's
 *  stacking context. */
function paintedAfterOf(boxes: readonly Box[], box: Box): Box[] {
  const at = paintOrderOf(box);
  if (!at) return boxes.slice();
  return boxes.filter((f) => {
    const key = paintOrderOf(f);
    if (!key) return true;
    for (let i = 0; i < key.length && i < at.length; i += 1) {
      if (key[i] !== at[i]) return key[i] > at[i];
    }
    return true;
  });
}

/** Whether `outer` is `box` or a box around it. */
function holds(outer: Box, box: Box): boolean {
  for (let at: Box | null = box; at; at = at.parent) {
    if (at === outer) return true;
  }
  return false;
}

const NO_BOXES: readonly Box[] = [];

/**
 * Where a sibling over the document stands for a replaced box, in device
 * pixels: its content box, its corners, what the boxes around it cut it to,
 * and how faded it is. Null for one a rectangle mounted over the document
 * cannot show as the document would: invisible, set aside, drawn through a
 * matrix, cut to what is no rectangle, or with something the document
 * paints after it over it.
 */
function placementOf(
  tree: BoxTree,
  box: Box,
  scale: number,
  /** Where given, the boxes painted after it that reach its picture are
   *  painted over it again where they can be (`coversOf`), and pushed
   *  here; where not, they keep it from being mounted. */
  drawnOver: Cover[] | null = null,
  /** Whether one in a box fixed to the viewport is placed, at the viewport
   *  (`atViewport`), rather than refused. */
  fixed = false,
): {
  element: Element;
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
  clip?: Rect;
  clipRadius?: number;
  opacity?: number;
  zoom?: number;
  atViewport?: true;
  held?: true;
  heldBy?: { x: number; y: number };
} | null {
  const el = box.el;
  if (!el) return null;
  // set aside by a layout that stopped short of it (`heldBack`)
  if (heldBack(tree, box)) return null;
  if (box.style.visibility !== 'visible') return null;
  const atViewport = drawnAtViewport(box);
  if (atViewport && !fixed) return null;
  if (!mountable(box)) return null;
  // what it is drawn through: a scale and a move, or nothing
  const zoom = zoomBetween(box);
  if (!zoom) return null;
  const zoomed = zoom !== NO_ZOOM;
  const picture = pixelsOf(box, zoom);
  if (!(picture.width > 0 && picture.height > 0)) return null;
  const corner = radiusOf(box);
  if (corner === null) return null;
  const radius = corner * zoom.k;
  // the boxes around it that clip it: to a rectangle, or to one with
  // round corners where they are one circle's and nothing else cuts it
  const cut = clipFor(
    box,
    picture,
    scale,
    null,
    zoomed ? (at) => zoomBetween(at) ?? NO_ZOOM : null,
  );
  if (cut === null) return null;
  const clip = cut?.rect;
  const round = cut ? cut.radius : 0;
  const shows = clip ? shownBy(clip, picture) : picture;
  const reach = inset(shows, OVERLAP);
  if (reach.width > 0 && reach.height > 0) {
    // the sticky boxes the viewport holds are asked about where the scroll
    // has them, as the fixed ones are, for an embedded element: asked of
    // them where they are when the mount is placed, a header held over a
    // frame refused the frame its mount, and the frame was blank under it
    // and below it. A player's covers paint one over it where it is held
    // (`coversOf`). And not for a box at the viewport, which `_viewportRect`
    // cuts by nothing
    const held = drawnOver || atViewport ? null : heldSet(tree);
    if (drawnOver && !zoomed && !atViewport) {
      // what the document paints after it, where a sibling after the
      // player can paint it again — from the box it is painted with, where
      // it is in a layer's flow (`coverersOver`); what is painted over it
      // again is painted where it is laid out, which under a scale around
      // it it is not. Where its place in the paint order cannot be told,
      // nothing but its own ink and its ancestors' may be within reach.
      const found = coverersOver(box, reach);
      if (found) {
        const over = coversOf(tree, found, shows, scale);
        if (!over) return null;
        drawnOver.push(...over);
      } else if (crowded(tree, box, reach)) return null;
    } else {
      // asked in the box's own coordinates where a scale is around it,
      // which the walk takes up through each context's
      // and, where it is fixed to the viewport, the boxes fixed there with
      // it in the same terms, which no scroll moves it against
      const fixedReach = atViewport ? reach : null;
      const after = zoomed
        ? paintedAfter(box, unzoomRect(zoom, reach), fixedReach, held, true)
        : paintedAfter(box, reach, fixedReach, held);
      if (after === null) {
        const inside = zoomed
          ? (parent: Box): Rect => unzoomRect(zoomBetween(parent)!, reach)
          : null;
        if (crowded(tree, box, reach, inside, held)) return null;
      } else if (after) return null;
    }
  }
  let opacity = 1;
  // up to a box in the top layer, which nothing around it fades
  for (let at: Box | null = box; at; at = at.topLayer ? null : at.parent) {
    opacity *= at.style.opacity;
  }
  const heldBy = zoomed ? null : heldShift(tree, box);
  return {
    element: el,
    ...picture,
    ...(radius > 0 && { radius }),
    // a rounded clip is the box it is the edge of, corners and all
    ...(round > 0
      ? { clip: clip!, clipRadius: round }
      : clip && !covers(clip, picture) && { clip: shows }),
    ...(opacity < 1 && { opacity: Math.max(0, opacity) }),
    // and what it shows is zoomed as the element's lengths are (CSS
    // Viewport 1, 5): a frame's document laid out at its CSS size
    ...(zoom.k * box.style.effectiveZoom !== 1 && {
      zoom: zoom.k * box.style.effectiveZoom,
    }),
    ...(atViewport && { atViewport: true as const }),
    ...(heldBy && { held: true as const, heldBy }),
  };
}

/** A box the document paints after a video, which reaches its picture,
 *  and the part of the picture it reaches, in device pixels: what a sibling
 *  after the player paints over it again. */
export interface Cover {
  box: Box;
  rect: Rect;
}

/** As many boxes painted after a video as are painted over its player
 *  again: more is a page laid over the video, which keeps the poster. */
const MAX_COVERS = 4;

/**
 * Of the boxes the document paints after a video whose ink reaches its
 * picture (`coverersOver`), each with the part of what the video `shows`
 * it reaches, where a sibling over the player can paint them as the
 * document does (`paintCover`): no more than `MAX_COVERS`, none held back
 * or fixed to the viewport, and each cut, where the boxes around it cut
 * it, to a rectangle. Null where any is not, and the video keeps its
 * poster. GitHub's hero has a play button in the corner of its video, and
 * diabrowser.com's a dock whose arc a scroll scales, under a halo it blurs
 * and fades.
 *
 * What a box is drawn through itself — its matrix, its opacity, its
 * filter, its mask, its clip path — is drawn over the player as the
 * document draws it over the poster. What is around it is not. A cover is
 * a layer of a context the video is in, and nothing between the two is a
 * group — a box that fades, turns, filters, masks or cuts to a path is a
 * context itself — so a box around a cover that does any of those holds the
 * video too, and the document fades or filters the two as one group, which
 * a player and a paint over it are two of. Nor does the canvas cut a cover
 * to a rounded box around it: it clips to a rectangle, and paints the
 * cover with none of the boxes around it. Until the player has a frame it
 * shows the document under it, so what of a cover is translucent is drawn
 * twice there for that long.
 */
function coversOf(
  tree: BoxTree,
  found: readonly Box[],
  shows: Rect,
  scale: number,
): Cover[] | null {
  if (found.length > MAX_COVERS) return null;
  const out: Cover[] = [];
  for (const cover of found) {
    if (heldBack(tree, cover) || drawnAtViewport(cover)) return null;
    for (
      let at = cover.topLayer ? null : cover.parent;
      at;
      at = at.topLayer ? null : at.parent
    ) {
      const style = at.style;
      if (
        placedMatrix(at) ||
        style.filter !== null ||
        style.clipPath ||
        masked(style) ||
        style.opacity < 1
      ) {
        return null;
      }
    }
    // where it is drawn: its own bounds are through its own matrix, as no
    // box's inside it are (`computePaintBounds`)
    const ink = {
      x: cover.boundsX,
      y: cover.boundsY,
      width: cover.boundsWidth,
      height: cover.boundsHeight,
    };
    const cut = clipFor(cover, ink, scale);
    if (cut === null || (cut && cut.radius > 0)) return null;
    const over = within(within(ink, shows), cut?.rect ?? ink);
    if (!(over.width > 0 && over.height > 0)) continue;
    out.push({ box: cover, rect: pixelsAround(over) });
  }
  return out;
}

/** Where two rects meet: none of either where they do not. */
function within(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

/** The least rect that holds all of `rects`. */
function around(rects: readonly Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The whole pixels a rect touches. */
function pixelsAround(rect: Rect): Rect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return {
    x,
    y,
    width: Math.ceil(rect.x + rect.width) - x,
    height: Math.ceil(rect.y + rect.height) - y,
  };
}

/**
 * A rect, cut by the boxes fixed to the viewport where the scroll has them,
 * `shift` from where they were laid out, and by the sticky boxes the
 * viewport holds, `held`, where the pane's scroll has put them already
 * (`_followViewport`): the band one takes off its top, its bottom or a
 * side, or `hidden` where one reaches into it in a way that leaves no
 * rectangle. Each is those the document paints after the rect's element
 * (`fixedOver`, `heldOver`), and only one painted over the document's flow
 * is asked about — one at a negative `z-index` is under it.
 *
 * A box cuts the rect where it draws something in it (`inkWithin`), and
 * not as far as its bounds reach: a fixed box's ink is the union of all it
 * holds, and joshwcomeau.com keeps a popup fixed over its article, a
 * wrapper with nothing of its own around a card at an opacity of 0, whose
 * ink a playground's frame reached once its divider was dragged. The frame
 * was hidden whole for it. Its header, held at the top, is a white bar and
 * its links over it, whose bounds reach a third of the bar again below it.
 * And a box that leaves no rectangle is asked again once the others have
 * cut the rect, which may leave it nothing to reach: the links come first
 * in the tree, and only the bar under them takes a band.
 */
export function cutByFixed(
  rect: Rect,
  fixed: readonly Box[],
  shift: { x: number; y: number } | null,
  held: readonly Box[] = NO_BOXES,
  /** What the pane shows of the document, where it is known: a box held
   *  at its top takes a band off what of the rect it shows, whatever of
   *  the rect is scrolled away above it. */
  viewport: Rect | null = null,
): Rect | 'hidden' {
  let x0 = rect.x;
  let y0 = rect.y;
  let x1 = rect.x + rect.width;
  let y1 = rect.y + rect.height;
  const dx = shift?.x ?? 0;
  const dy = shift?.y ?? 0;
  // each with how far the scroll moved it from where its boxes are
  let left: [Box, number, number][] = [];
  for (const box of fixed) left.push([box, dx, dy]);
  for (const box of held) left.push([box, 0, 0]);
  for (let cut = true; cut && left.length;) {
    cut = false;
    const again: [Box, number, number][] = [];
    for (const entry of left) {
      const [box, sx, sy] = entry;
      if (!(box.boundsWidth > 0 && box.boundsHeight > 0)) continue;
      const z = box.style.zIndex;
      if (typeof z === 'number' && z < 0) continue;
      // what of the rect shows, where its boxes are: for a fixed one, at
      // the document's top
      const vx0 = viewport ? Math.max(x0, viewport.x) : x0;
      const vy0 = viewport ? Math.max(y0, viewport.y) : y0;
      const vx1 = viewport ? Math.min(x1, viewport.x + viewport.width) : x1;
      const vy1 = viewport ? Math.min(y1, viewport.y + viewport.height) : y1;
      // nothing of it shows, which nothing hides
      if (!(vx1 > vx0 && vy1 > vy0)) return spanned(x0, y0, x1, y1);
      const within = {
        x: vx0 - sx,
        y: vy0 - sy,
        width: vx1 - vx0,
        height: vy1 - vy0,
      };
      const ink = inkWithin(box, within);
      // a rect that only gets smaller is never reached by it
      if (!ink) continue;
      const right = ink.x + ink.width;
      const bottom = ink.y + ink.height;
      const across =
        ink.x <= within.x + EDGE && right >= within.x + within.width - EDGE;
      const down =
        ink.y <= within.y + EDGE && bottom >= within.y + within.height - EDGE;
      if (across && ink.y <= within.y + EDGE) y0 = Math.min(y1, bottom + sy);
      else if (across && bottom >= within.y + within.height - EDGE) {
        y1 = Math.max(y0, ink.y + sy);
      } else if (down && ink.x <= within.x + EDGE) {
        x0 = Math.min(x1, right + sx);
      } else if (down && right >= within.x + within.width - EDGE) {
        x1 = Math.max(x0, ink.x + sx);
      } else {
        again.push(entry);
        continue;
      }
      cut = true;
    }
    left = again;
  }
  if (left.length && x1 > x0 && y1 > y0) return 'hidden';
  return spanned(x0, y0, x1, y1);
}

/** The rect between two corners, of no size where they cross. */
function spanned(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
  };
}

/** How far short of an edge of the rect, in device pixels, ink that
 *  reaches it may be by the arithmetic that cut it to the rect. */
const EDGE = 1e-3;

/**
 * How far into the picture, in device pixels, a box may reach and not be
 * over it: the picture is on whole pixels, and the box after a video in
 * the flow starts at a fraction of one — the line a video is on ends a
 * descent below it — so the two share a row of pixels that has nothing of
 * the box's in it.
 */
const OVERLAP = 0.5;

function inset(rect: Rect, by: number): Rect {
  return {
    x: rect.x + by,
    y: rect.y + by,
    width: Math.max(0, rect.width - 2 * by),
    height: Math.max(0, rect.height - 2 * by),
  };
}

/**
 * Whether a sibling over the document can stand for the video: no matrix
 * the document draws it through, on it or around it, but a scale the same
 * across as down — its translation is layout's and moves the box — no
 * `clip-path` or mask, which cut it to
 * what a rectangle is not, no filter, which is run over the pixels the
 * document draws. (Not fixed to the viewport either, which a sibling the
 * document scrolls does not follow, but for what `placementOf` mounts
 * where the viewport is.)
 */
function mountable(box: Box): boolean {
  for (let at: Box | null = box; at; at = at.topLayer ? null : at.parent) {
    // but a scale the same both ways, which a rectangle still follows
    const matrix = placedMatrix(at);
    if (matrix && evenScaleOf(matrix) === null) return false;
    if (at.style.clipPath || masked(at.style)) return false;
    // a filter is run over the pixels the document draws, which a player
    // over them is not
    if (at.style.filter !== null) return false;
  }
  return true;
}

/** A box's content box on the pixels the document draws its image on,
 *  where `zoom` draws it. */
function pixelsOf(box: Box, zoom: Zoom): Rect {
  const r = zoomRect(zoom, {
    x: box.contentX,
    y: box.contentY,
    width: box.contentWidth,
    height: box.contentHeight,
  });
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return {
    x,
    y,
    width: Math.round(r.x + r.width) - x,
    height: Math.round(r.y + r.height) - y,
  };
}

/**
 * The radius of a box's content corners: 0 where they are square, the one
 * radius where all four are the same circle, and null where they are not —
 * a picture the document trims to one rounded corner, or to an ellipse, is
 * nothing a box's one `borderRadius` cuts.
 */
function radiusOf(box: Box): number | null {
  const corners = contentCorners(box);
  if (!corners) return 0;
  // nor is a corner `corner-shape` draws otherwise than round
  if (corners.shape) return null;
  const r = corners.x[0];
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(corners.x[i] - r) > 0.5 || Math.abs(corners.y[i] - r) > 0.5) {
      return null;
    }
  }
  return r;
}
