// Clipping geometry to the target, and why anything has to.
//
// **Coordinates in this renderer are bounded and the world's are not.**
// ntk hands a stroke's geometry to XRender as 16.16 fixed point, which
// overflows a signed 32-bit word at 32,768, and a composite's coordinates
// are int16. Two things routinely exceed that:
//
//  - an **overlay**, which is geography: a route's far end stays where it
//    is when the camera zooms into one corner of it, and a world is
//    `512 · 2^zoom` pixels — 134 million at zoom 20;
//  - a **tile drawn past its own depth**, where one source tile is
//    rasterized into each cell of a grid over it, so a tile-wide polygon is
//    `span` tiles wide in the surface's pixels.
//
// Both want the same two algorithms, so they live here rather than twice.
// Cohen-Sutherland for a line, because the common case is a segment wholly
// inside or wholly outside and both are answered by one `&`/`|` of the
// endpoints' codes with no arithmetic at all; Sutherland-Hodgman for an
// area, because a fill needs a closed boundary — the part of a polygon that
// crosses the window has to come back along the window's edge, which
// segment clipping cannot produce.

/** The clip window, in the same target pixels the path is built in. */
export interface ClipRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * How far outside the pane geometry is still kept.
 *
 * Not zero: a line clipped exactly at the edge would have its join and its
 * cap drawn at the boundary rather than outside it, which shows as a blunt
 * end against the pane's edge. A margin wider than any stroke this draws
 * puts those artefacts off-screen, and is still far inside the range that
 * overflows.
 */
export const CLIP_MARGIN = 256;

export function clipOf(
  pane: { x: number; y: number; width: number; height: number },
  scale: number,
): ClipRect {
  return {
    minX: (pane.x - CLIP_MARGIN) * scale,
    minY: (pane.y - CLIP_MARGIN) * scale,
    maxX: (pane.x + pane.width + CLIP_MARGIN) * scale,
    maxY: (pane.y + pane.height + CLIP_MARGIN) * scale,
  };
}

const INSIDE = 0;
const LEFT = 1;
const RIGHT = 2;
const BOTTOM = 4;
const TOP = 8;

function outcode(x: number, y: number, clip: ClipRect): number {
  let code = INSIDE;
  if (x < clip.minX) code |= LEFT;
  else if (x > clip.maxX) code |= RIGHT;
  if (y < clip.minY) code |= BOTTOM;
  else if (y > clip.maxY) code |= TOP;
  return code;
}

/**
 * Cohen-Sutherland: the visible piece of one segment, or null.
 *
 * Chosen over Liang-Barsky because the common case here is a segment wholly
 * inside or wholly outside, and both are answered by one `&`/`|` of the two
 * endpoints' codes with no arithmetic at all.
 */
export function clipSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  clip: ClipRect,
): [number, number, number, number] | null {
  let x0 = ax;
  let y0 = ay;
  let x1 = bx;
  let y1 = by;
  let code0 = outcode(x0, y0, clip);
  let code1 = outcode(x1, y1, clip);
  for (;;) {
    if ((code0 | code1) === 0) return [x0, y0, x1, y1]; // both inside
    if ((code0 & code1) !== 0) return null; // both beyond one edge
    const code = code0 !== 0 ? code0 : code1;
    let x = 0;
    let y = 0;
    if (code & TOP) {
      x = x0 + ((x1 - x0) * (clip.maxY - y0)) / (y1 - y0);
      y = clip.maxY;
    } else if (code & BOTTOM) {
      x = x0 + ((x1 - x0) * (clip.minY - y0)) / (y1 - y0);
      y = clip.minY;
    } else if (code & RIGHT) {
      y = y0 + ((y1 - y0) * (clip.maxX - x0)) / (x1 - x0);
      x = clip.maxX;
    } else {
      y = y0 + ((y1 - y0) * (clip.minX - x0)) / (x1 - x0);
      x = clip.minX;
    }
    if (code === code0) {
      x0 = x;
      y0 = y;
      code0 = outcode(x0, y0, clip);
    } else {
      x1 = x;
      y1 = y;
      code1 = outcode(x1, y1, clip);
    }
  }
}

/**
 * Sutherland-Hodgman: a ring clipped to the rectangle, in place of the
 * original.
 *
 * Rings rather than segments, because a fill needs a closed boundary: the
 * part of a polygon that crosses the window has to come back along the
 * window's edge, which segment clipping cannot produce. Winding is
 * preserved, so an interior ring stays an interior ring and the non-zero
 * fill still puts a hole where one belongs.
 */
export function clipRing(points: readonly number[], clip: ClipRect): number[] {
  let output = [...points];
  const edges: [
    (x: number, y: number) => boolean,
    (ax: number, ay: number, bx: number, by: number) => [number, number],
  ][] = [
    [
      (x) => x >= clip.minX,
      (ax, ay, bx, by) => [
        clip.minX,
        ay + ((by - ay) * (clip.minX - ax)) / (bx - ax),
      ],
    ],
    [
      (x) => x <= clip.maxX,
      (ax, ay, bx, by) => [
        clip.maxX,
        ay + ((by - ay) * (clip.maxX - ax)) / (bx - ax),
      ],
    ],
    [
      (_x, y) => y >= clip.minY,
      (ax, ay, bx, by) => [
        ax + ((bx - ax) * (clip.minY - ay)) / (by - ay),
        clip.minY,
      ],
    ],
    [
      (_x, y) => y <= clip.maxY,
      (ax, ay, bx, by) => [
        ax + ((bx - ax) * (clip.maxY - ay)) / (by - ay),
        clip.maxY,
      ],
    ],
  ];
  for (const [inside, intersect] of edges) {
    const input = output;
    output = [];
    if (input.length < 6) return [];
    for (let i = 0; i < input.length; i += 2) {
      const ax = input[i];
      const ay = input[i + 1];
      const bx = input[(i + 2) % input.length];
      const by = input[(i + 3) % input.length];
      const aIn = inside(ax, ay);
      const bIn = inside(bx, by);
      if (aIn) output.push(ax, ay);
      if (aIn !== bIn) {
        const [ix, iy] = intersect(ax, ay, bx, by);
        output.push(ix, iy);
      }
    }
  }
  return output;
}
