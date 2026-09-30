// A text engine that sets a variable web font at the weight CSS says.
//
// A style's weight picks a face, and where the face is a variable font it is
// also a place on the font's `wght` axis — the style's weight, clamped to
// the range the face's `@font-face` rule declares (CSS Fonts 4, 7.2). The
// rule is the document's and not the engine's, so which value that is is
// the document's to say (`WebFonts.wght`), and it is said with the run: a
// run's `variations`, which both engines take, and which wins over whatever
// an engine would have done with the weight by itself. ntk moves the axis
// to the style's weight, past a rule that declared less of it; CoreText,
// handed a face react-x11 registered, does not move it at all, and every
// weight of a page set in Geist was the regular on macOS.
//
// Only a run whose list leads with such a face is touched, and it is handed
// on as a copy: the run is the caller's, and the layouts kept from one pass
// to the next are found by its fields (`TextLayoutCache`), which this is
// below and adds nothing to. A run in any other family carries no
// `variations` — an axis value set on the system's own variable font would
// be this document's rule applied to a font it never declared.
import type { TextRun } from '../../richtext/index.js';
import type { FontsLike } from './inline.js';
import { withLayout } from './shaping.js';

/** What says where on its weight axis text is set: `WebFonts`. */
export interface WeightAxes {
  /** Whether any family has an axis to set. While none has, the engine is
   *  called as it is. */
  readonly variable: boolean;
  wght(list: string, weight: number, italic: boolean): { wght: number } | null;
}

const NUMERIC: Record<string, number> = { normal: 400, bold: 700 };

/** `engine`, laying each run out at the weight axis value `axes` gives its
 *  family list, weight and slant. */
export function weightAxes(engine: FontsLike, axes: WeightAxes): FontsLike {
  return withLayout(engine, (content, style, options) => {
    if (!axes.variable || !Array.isArray(content)) {
      return engine.layout(content, style, options);
    }
    let runs: TextRun[] | null = null;
    for (let i = 0; i < content.length; i += 1) {
      const run = content[i];
      const family = run.family ?? style.family;
      const weight = run.weight ?? style.weight ?? 400;
      const axis =
        typeof family === 'string'
          ? axes.wght(
              family,
              typeof weight === 'number'
                ? weight
                : (NUMERIC[weight as string] ?? 400),
              (run.style ?? style.style) === 'italic',
            )
          : null;
      if (!axis) continue;
      runs ??= content.slice();
      runs[i] = { ...run, variations: axis } as TextRun;
    }
    return engine.layout(runs ?? content, style, options);
  });
}
