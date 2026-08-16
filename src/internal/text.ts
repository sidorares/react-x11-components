// The bits `<richtext>` and `<Html>` need that react-x11 has but does not
// export. Same situation, and the same shape, as `src/calendar/internal.ts` —
// each is small and pure, and if core ever puts one on its exports map,
// delete it from here and import it. `tint` was the first to go that way: it
// is `react-x11/style`'s now, and the surfaces here import it from there.
//
// It sits in `src/internal/` rather than in `src/richtext/` because two
// things share it now — the shared module and `src/html/`'s own layout — and
// that is exactly what this directory is for (AGENTS.md, "the half-step below
// a shared module").

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
