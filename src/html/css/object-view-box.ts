// `object-view-box` (CSS Images 5, 6.6): a rectangle over a replaced
// element's content, as an SVG's `viewBox` is over a drawing, that stands
// for all of it. Its size is the element's natural size, so layout sizes
// the element from it (`ownIntrinsic`), and `object-fit` and
// `object-position` place it in the content box, the rest of the content
// around it (`fitted`, in `paint.ts`). Read here and not in `style.ts`,
// since `el.style`'s check of a value (`specified.ts`) reads it too.

import { AUTO, parseLength, resolve, splitValue } from './values.js';
import type { Len, UnitContext } from './values.js';

/** The view box as computed: a `<basic-shape-rect>` (CSS Shapes 1, 3.1),
 *  kept as the function it was written as, its corners — which round
 *  nothing here — left out. */
export interface ObjectViewBox {
  shape: 'inset' | 'rect' | 'xywh';
  /** `inset()`'s distances in from the top, right, bottom and left;
   *  `rect()`'s top, right, bottom and left edges from the top and the
   *  left, `auto` the content's own; `xywh()`'s left, top, width and
   *  height. Device pixels, or percentages of the natural size. */
  lengths: readonly [Len, Len, Len, Len];
}

/**
 * `object-view-box`'s value: null for `none`, undefined for no value of the
 * property — a circle, a polygon, a path, a width below nothing.
 */
export function parseObjectViewBox(
  value: string,
  ctx: UnitContext,
): ObjectViewBox | null | undefined {
  const text = value.trim();
  if (text.toLowerCase() === 'none') return null;
  const m = /^(inset|rect|xywh)\(([\s\S]*)\)$/i.exec(text);
  if (!m) return undefined;
  const shape = m[1].toLowerCase() as ObjectViewBox['shape'];
  const parts = splitValue(m[2].trim());
  const round = parts.findIndex((p) => p.toLowerCase() === 'round');
  const sides = round < 0 ? parts : parts.slice(0, round);
  if (round >= 0 && !radiiValid(parts.slice(round + 1))) return undefined;
  if (
    shape === 'inset' ? !sides.length || sides.length > 4 : sides.length !== 4
  )
    return undefined;
  const lengths: Len[] = [];
  for (let i = 0; i < sides.length; i += 1) {
    const len = parseLength(sides[i], ctx);
    if (len === null) return undefined;
    // only `rect()` has an edge that is `auto`, and a width is not negative
    if (len === AUTO && shape !== 'rect') return undefined;
    if (shape === 'xywh' && i > 1 && typeof len === 'number' && len < 0)
      return undefined;
    if (shape === 'xywh' && i > 1 && typeof len === 'object' && len.pct < 0)
      return undefined;
    lengths.push(len);
  }
  const [a, b = a, c = a, d = b] = lengths;
  return { shape, lengths: [a, b, c, d] };
}

/** Whether what follows `round` is a `border-radius`: one to four lengths
 *  or percentages none below nothing, and as many again after a `/`. */
function radiiValid(parts: string[]): boolean {
  const slash = parts.indexOf('/');
  const halves =
    slash < 0 ? [parts] : [parts.slice(0, slash), parts.slice(slash + 1)];
  for (const half of halves) {
    if (!half.length || half.length > 4) return false;
    for (const part of half) {
      const len = parseLength(part, {
        em: 16,
        rem: 16,
        vw: 1,
        vh: 1,
        scale: 1,
      });
      if (len === null || len === AUTO) return false;
      if (typeof len === 'number' ? len < 0 : len.pct < 0) return false;
    }
  }
  return true;
}

/**
 * Where a view box is in content `width` by `height`, from the content's
 * top left corner and of its own size, its percentages of those. Null
 * where it has no area, which is no view box at all: `inset(50px 0 50px 0)`
 * of something 100 tall shows the whole of it, as browsers show it.
 */
export function viewBoxIn(
  box: ObjectViewBox,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  const [a, b, c, d] = box.lengths;
  let x: number;
  let y: number;
  let w: number;
  let h: number;
  if (box.shape === 'inset') {
    x = resolve(d, width);
    y = resolve(a, height);
    w = width - x - resolve(b, width);
    h = height - y - resolve(c, height);
  } else if (box.shape === 'rect') {
    y = a === AUTO ? 0 : resolve(a, height);
    const right = b === AUTO ? width : resolve(b, width);
    const bottom = c === AUTO ? height : resolve(c, height);
    x = d === AUTO ? 0 : resolve(d, width);
    w = right - x;
    h = bottom - y;
  } else {
    x = resolve(a, width);
    y = resolve(b, height);
    w = resolve(c, width);
    h = resolve(d, height);
  }
  return w > 0 && h > 0 && Number.isFinite(x + y + w + h)
    ? { x, y, width: w, height: h }
    : null;
}
