// The bits `<Markdown>` needs that react-x11 has but does not export.
// Same situation, and the same shape, as `src/calendar/internal.ts` — each
// is small and pure, and if core ever puts one on its exports map, delete
// it from here and import it. (`src/calendar` keeps its own copy: no
// component imports another component, and a shared module for two
// ten-line functions would couple their release cadence for nothing.)

// Read off the namespace rather than declared through `declare module`: an
// augmentation would be emitted into this package's own `.d.ts`, and a
// program holding both the source and the build — which is what
// `npm run typecheck` does — would see it twice and reject it.
import * as ntk from 'react-x11/ntk';

/** `[r, g, b, a]`, each 0-1, unassociated (not premultiplied). */
type StraightColor = [number, number, number, number];

const cssColorStraight = (
  ntk as unknown as {
    cssColorStraight: (color: string) => StraightColor | null;
  }
).cssColorStraight;

function rgba(c: StraightColor): string {
  return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;
}

/**
 * A colour at a given opacity — `tint('#2980b9', 0.35)`.
 *
 * The selection band and the inline-code background are both fills drawn
 * *under* ink whose colour they do not control, so an opaque value cannot be
 * chosen once for both a light and a dark palette. A translucent one works
 * against either surface, and the ink keeps whatever contrast it had.
 */
export function tint(color: string, alpha: number): string {
  const c = cssColorStraight(color);
  if (!c) return color;
  return rgba([c[0], c[1], c[2], c[3] * alpha]);
}

// --- code points vs code units ---------------------------------------------
//
// ntk's line runs report their extent in **code units** while its caret API
// speaks **code points**, so anything reading run geometry has to translate.
// Core has exactly these two functions in `src/textrange.js` (react-x11#291)
// and its `<text>` uses them for the same purpose; they are copied rather
// than imported because that module is not on core's exports map. Delete
// them the day it is.

/** Code point index -> UTF-16 offset, with one extra entry for the end. */
export function codeUnitOffsets(text: string): number[] {
  const offsets: number[] = [];
  const s = text ?? '';
  for (let i = 0; i < s.length;) {
    offsets.push(i);
    i += (s.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  }
  offsets.push(s.length);
  return offsets;
}

/** The code point index for a UTF-16 offset, rounded down to a whole
 *  character. Binary search over `codeUnitOffsets`. */
export function codePointAtOffset(offsets: number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
