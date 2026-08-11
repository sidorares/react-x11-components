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

/** ntk's fence tokenizer (a maintained adapter over highlight.js, already
 *  in ntk's dependency closure). Loose-typed like the rest of `ntk.d.ts`;
 *  absent (an older ntk) simply means unhighlighted code. */
export interface CodeToken {
  text: string;
  kind:
    | 'keyword'
    | 'literal'
    | 'string'
    | 'number'
    | 'comment'
    | 'tag'
    | 'attr'
    | 'function'
    | 'plain';
}

export const highlightCode: ((code: string, lang: string) => CodeToken[]) | undefined = (
  ntk as unknown as {
    highlightCode?: (code: string, lang: string) => CodeToken[];
  }
).highlightCode;

/**
 * The letter of a Ctrl chord, lowercased. Vendored: `react-x11/keysyms`
 * exports it at runtime but `keysyms.d.ts` names only the `XK_*`
 * constants. ntk derives `codepoint` from the *shifted* keysym, so Ctrl+C
 * must be read this way rather than off `ev.key`.
 */
export function ctrlChordLetter(ev: {
  keysym?: number;
  codepoint?: number;
}): number | null {
  const code = ev.keysym ?? ev.codepoint;
  if (code == null) return null;
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}
