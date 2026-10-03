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
//  - **Nothing the document paints after the video may reach its picture.**
//    A player is above the whole document, so a caption laid across a
//    video, a play button over it or a gradient on top of a hero would be
//    hidden under it. Such a video stays its poster (`paintedAfter`, and
//    `crowded` where its place in the paint order cannot be told) — the same
//    test a sprite's layer is held to (`sprites.ts`).
//  - **A box fixed to the viewport is asked about as the pane scrolls**
//    (`cutByFixed`): a header that comes over a playing video cuts the
//    player where it reaches it, and one that reaches into its middle hides
//    it, the poster drawn there in the meantime and the video playing on.
//  - **What a rectangle cannot follow keeps the poster**: a transform, a
//    `clip-path` or a mask on the video or around it, a video fixed to the
//    viewport, and corners of its own, or of a box around it that cuts it,
//    that are not all one circle.
//
// Nothing is fetched here either. Each source is the host's to answer
// (`ResourceRequest.kind: 'video'`): with a `src` the platform's player
// opens itself, with a `VideoFrames` sink it feeds, or with `null`, which
// keeps the poster. A source the player then fails on is the next one's
// turn, as HTML's `<source>` list goes.
import type { Element } from 'domhandler';

import { between, covers } from './controls.js';
import { attr, isElement, tagOf } from './dom.js';
import type { ComputedStyle } from './css/style.js';
import { masked } from './css/style.js';
import { heldBack, placedMatrix } from './layout/block.js';
import type { Box, BoxTree } from './layout/boxes.js';
import {
  clipFor,
  contentCorners,
  drawnAtViewport,
  paintedAfter,
} from './paint.js';
import type { VideoSource } from './resources.js';
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
  /** HTML's attributes, as the element has them. */
  autoPlay: boolean;
  loop: boolean;
  muted: boolean;
  /** Whether the page asked for controls: a press plays and pauses. */
  controls: boolean;
  /** What an assistive technology names it: `aria-label`, or `title`. */
  label?: string;
}

/**
 * The sources a `<video>` names, in the order it would try them: its `src`
 * alone where it has one — an empty one is none — and its `<source>`
 * children otherwise (HTML 4.8.11.5, the resource selection algorithm).
 * A `<source media>` is not evaluated.
 */
export function videoCandidates(el: Element): VideoCandidate[] {
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
    const type = attr(child, 'type')?.trim();
    out.push(type ? { url, type } : { url });
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
): MediaRect[] {
  const out: MediaRect[] = [];
  for (const box of tree.media) {
    const el = box.el;
    if (!el) continue;
    // set aside by a layout that stopped short of it (`heldBack`)
    if (heldBack(tree, box)) continue;
    if (box.style.visibility !== 'visible') continue;
    if (!mountable(box)) continue;
    const picture = pixelsOf(box);
    if (!(picture.width > 0 && picture.height > 0)) continue;
    const radius = radiusOf(box);
    if (radius === null) continue;
    // the boxes around it that clip it: to a rectangle, or to one with
    // round corners where they are one circle's and nothing else cuts it
    const cut = clipFor(box, picture, scale);
    if (cut === null) continue;
    const clip = cut?.rect;
    const round = cut ? cut.radius : 0;
    const shows = clip ? between(clip, picture) : picture;
    const reach = inset(shows, OVERLAP);
    if (
      reach.width > 0 &&
      reach.height > 0 &&
      (paintedAfter(box, reach) ?? crowded(tree, box, reach))
    ) {
      continue;
    }
    // asked last, and only of what can be mounted: a host is not asked for
    // a video nothing would show
    const chosen = sourceOf(el);
    if (!chosen) continue;
    let opacity = 1;
    for (let at: Box | null = box; at; at = at.parent) {
      opacity *= at.style.opacity;
    }
    const label = attr(el, 'aria-label') || attr(el, 'title');
    out.push({
      element: el,
      source: chosen.source,
      url: chosen.url,
      ...picture,
      fit: box.style.objectFit,
      ...(radius > 0 && { radius }),
      // a rounded clip is the box it is the edge of, corners and all
      ...(round > 0
        ? { clip: clip!, clipRadius: round }
        : clip && !covers(clip, picture) && { clip: shows }),
      ...(opacity < 1 && { opacity: Math.max(0, opacity) }),
      autoPlay: attr(el, 'autoplay') !== undefined,
      loop: attr(el, 'loop') !== undefined,
      muted: attr(el, 'muted') !== undefined,
      controls: attr(el, 'controls') !== undefined,
      ...(label && { label }),
    });
  }
  return out;
}

/**
 * A rect, cut by the boxes fixed to the viewport where the scroll has them,
 * `shift` from where they were laid out: the band one takes off its top, its
 * bottom or a side, or `hidden` where one reaches into it in a way that
 * leaves no rectangle. Only a box painted over the document's flow is
 * asked about — one at a negative `z-index` is under it.
 */
export function cutByFixed(
  rect: Rect,
  fixed: readonly Box[],
  shift: { x: number; y: number } | null,
): Rect | 'hidden' {
  let x0 = rect.x;
  let y0 = rect.y;
  let x1 = rect.x + rect.width;
  let y1 = rect.y + rect.height;
  const dx = shift?.x ?? 0;
  const dy = shift?.y ?? 0;
  for (const box of fixed) {
    if (!(box.boundsWidth > 0 && box.boundsHeight > 0)) continue;
    const z = box.style.zIndex;
    if (typeof z === 'number' && z < 0) continue;
    const bx0 = box.boundsX + dx;
    const by0 = box.boundsY + dy;
    const bx1 = bx0 + box.boundsWidth;
    const by1 = by0 + box.boundsHeight;
    if (bx1 <= x0 || bx0 >= x1 || by1 <= y0 || by0 >= y1) continue;
    const across = bx0 <= x0 && bx1 >= x1;
    const down = by0 <= y0 && by1 >= y1;
    if (across && by0 <= y0) y0 = Math.min(y1, by1);
    else if (across && by1 >= y1) y1 = Math.max(y0, by0);
    else if (down && bx0 <= x0) x0 = Math.min(x1, bx1);
    else if (down && bx1 >= x1) x1 = Math.max(x0, bx0);
    else return 'hidden';
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

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
 * the document draws it through, on it or around it — its translation is
 * layout's and moves the box — no `clip-path` or mask, which cut it to
 * what a rectangle is not, and not fixed to the viewport, which a sibling
 * the document scrolls does not follow.
 */
function mountable(box: Box): boolean {
  if (drawnAtViewport(box)) return false;
  for (let at: Box | null = box; at; at = at.parent) {
    if (placedMatrix(at)) return false;
    if (at.style.clipPath || masked(at.style)) return false;
  }
  return true;
}

/** A box's content box on the pixels the document draws its image on. */
function pixelsOf(box: Box): Rect {
  const x = Math.round(box.contentX);
  const y = Math.round(box.contentY);
  return {
    x,
    y,
    width: Math.round(box.contentX + box.contentWidth) - x,
    height: Math.round(box.contentY + box.contentHeight) - y,
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
  const r = corners.x[0];
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(corners.x[i] - r) > 0.5 || Math.abs(corners.y[i] - r) > 0.5) {
      return null;
    }
  }
  return r;
}
