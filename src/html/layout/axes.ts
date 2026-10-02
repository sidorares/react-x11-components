// A text engine that sets a web font at the weight and the width CSS says.
//
// A style's weight picks a face, and where the face is a variable font it is
// also a place on the font's `wght` axis — the style's weight, clamped to
// the range the face's `@font-face` rule declares (CSS Fonts 4, 7.2). A
// style's width, its `font-stretch`, is the same on the `wdth` axis. The
// rule is the document's and not the engine's, so which values those are
// is the document's to say (`WebFonts.setting`), and they are said with the
// run: a run's `variations`, which both engines take, and which win over
// whatever an engine would have done with the weight by itself. ntk moves
// the weight axis to the style's weight, past a rule that declared less of
// it; CoreText, handed a face react-x11 registered, does not move it at
// all, and every weight of a page set in Geist was the regular on macOS.
// Neither engine knows a width: a run's `stretch` is the document's, and
// read here alone.
//
// A family whose faces are of several widths is registered a name for each,
// since an engine picks among a name's faces by weight and slant, so a run
// is also handed the list with its width's name first.
//
// Only a run whose list leads with such a face is touched, and it is handed
// on as a copy: the run is the caller's, and the layouts kept from one pass
// to the next are found by its fields (`TextLayoutCache`), which this is
// below and adds nothing to. A run in any other family carries no
// `variations` — an axis value set on the system's own variable font would
// be this document's rule applied to a font it never declared.
import type { FaceSetting } from '../fonts.js';
import type { DocumentRun, FontsLike } from './inline.js';
import { withLayout } from './shaping.js';

/** What says how a run in a family is set: `WebFonts`. */
export interface FaceSettings {
  /** Whether any family has a face to set otherwise than as the engine
   *  would. While none has, the engine is called as it is. */
  readonly active: boolean;
  setting(
    list: string,
    weight: number,
    italic: boolean,
    stretch: number,
  ): FaceSetting | null;
}

const NUMERIC: Record<string, number> = { normal: 400, bold: 700 };

/** `engine`, laying each run out in the family list and at the axis values
 *  `faces` gives its family list, weight, slant and width. */
export function fontAxes(engine: FontsLike, faces: FaceSettings): FontsLike {
  return withLayout(engine, (content, style, options) => {
    if (!faces.active || !Array.isArray(content)) {
      return engine.layout(content, style, options);
    }
    let runs: DocumentRun[] | null = null;
    for (let i = 0; i < content.length; i += 1) {
      const run = content[i];
      const family = run.family ?? style.family;
      const weight = run.weight ?? style.weight ?? 400;
      const stretch = run.stretch ?? style.stretch ?? 100;
      const setting =
        typeof family === 'string'
          ? faces.setting(
              family,
              typeof weight === 'number'
                ? weight
                : (NUMERIC[weight as string] ?? 400),
              (run.style ?? style.style) === 'italic',
              typeof stretch === 'number' ? stretch : 100,
            )
          : null;
      if (!setting) continue;
      const set: DocumentRun & { variations?: object } = { ...run };
      if (setting.family !== family) set.family = setting.family;
      if (setting.variations) set.variations = setting.variations;
      runs ??= content.slice();
      runs[i] = set;
    }
    return engine.layout(runs ?? content, style, options);
  });
}
