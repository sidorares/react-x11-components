// Where everything a box holds was laid out, in the box's own coordinates.
//
// A surface kept for a box (`SpriteStore`) holds what the box drew, and a
// layout at another width throws it away, because a layout can move and
// size anything. Most of what a width moves, though, it only moves: a card
// of a fixed width in a column that narrows is where it was relative to its
// own corner, line for line, and what it draws is what it drew. This is the
// record that says so — taken when the surface is made, and compared after
// the layout (`shapesEqual`).

import type { Box } from './boxes.js';

/**
 * The place, size and ink of a box and of every box in it, each line's
 * place and the stretch of text it shows, and each piece of text's place on
 * its line — relative to the box's corner, which a layout may move freely.
 * Layout writes document coordinates into all of them (`translate` moves
 * the lines and the text with their box), so the record is the box's own
 * and not where it stands.
 *
 * Equal records say the box draws what it drew, given the same styles —
 * which only a build changes, and a build forgets the surfaces itself. What
 * a box draws from the viewport rather than from its layout (a fixed
 * background, a box fixed to the viewport) is the painter's to refuse
 * (`drawsAgainstViewport`, `holdsViewportFixed`), as it does a surface for
 * one in the first place.
 */
export function layoutShape(box: Box): number[] {
  const ox = box.x;
  const oy = box.y;
  const out: number[] = [];
  const stack: Box[] = [box];
  while (stack.length) {
    const at = stack.pop()!;
    if (UNLAID.has(at.kind)) {
      // An inline box's rect is never laid out — `translate` moves it with
      // the rest, so it adds up across passes, and nothing may read it. What
      // it holds is in its block's lines; only where it stands in the tree
      // is its own.
      out.push(-1, at.children.length);
      for (let i = at.children.length - 1; i >= 0; i--) {
        stack.push(at.children[i]);
      }
      continue;
    }
    out.push(
      at.x - ox,
      at.y - oy,
      at.width,
      at.height,
      at.boundsX - ox,
      at.boundsY - oy,
      at.boundsWidth,
      at.boundsHeight,
      at.cut,
      at.children.length,
    );
    const lines = at.lines;
    out.push(lines?.length ?? -1);
    if (lines) {
      for (const line of lines) {
        out.push(
          line.x - ox,
          line.y - oy,
          line.width,
          line.height,
          line.baseline,
          line.textStart,
          line.textEnd,
          line.texts.length,
          line.atomics.length,
          line.edges?.length ?? 0,
        );
        for (const text of line.texts) {
          out.push(
            text.drawX - ox,
            text.drawY - oy,
            text.textStart,
            text.textEnd,
            text.layoutStart,
            text.layoutLine,
            text.layout.width,
            text.trail ?? -1,
            text.gaps?.length ?? -1,
          );
          // a justified line's spaces, which move the words and not the text
          if (text.gaps) for (const gap of text.gaps) out.push(gap);
        }
        for (const placed of line.atomics) {
          out.push(placed.x - ox, placed.y - oy);
        }
        if (line.edges) {
          for (const edge of line.edges) out.push(edge.x - ox, edge.width);
        }
      }
    }
    for (let i = at.children.length - 1; i >= 0; i--) {
      stack.push(at.children[i]);
    }
  }
  return out;
}

/** The kinds of box whose own rect a layout does not set. */
const UNLAID: ReadonlySet<Box['kind']> = new Set(['inline', 'text', 'break']);

/** Whether two `layoutShape` records are the same layout. */
export function shapesEqual(
  a: readonly number[],
  b: readonly number[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !(Math.abs(a[i] - b[i]) < SAME_PLACE)) return false;
  }
  return true;
}

/** How close two places in a record are that are one: a box a drag moves
 *  a fraction of a pixel at a time has its parts' places from its corner
 *  worked out in other last bits at each. */
const SAME_PLACE = 1e-6;
