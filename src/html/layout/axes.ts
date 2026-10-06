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
//
// And a face is set at the size its rule says, and stands in lines of the
// height it says (CSS Fonts 5, 4.11, 4.12): `size-adjust` scales the run's
// size, and the face `match` answers metrics with — its own scaled, or the
// overrides', a fraction of the size scaled too — so a line's height, its
// strut and an `ex` are the rule's wherever the layout asks. A `local()`
// face is the system's family under its own name, which another list may
// name as well, so `map` marks the one it came to with the group's name
// after it, and the setting is the list without it (`WebFonts.setting`).
import type { FaceMetrics as FaceRuleMetrics, FaceSetting } from '../fonts.js';
import type { DocumentRun, FaceMetrics, FontsLike } from './inline.js';
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

/** `engine`, laying each run out in the family list, at the axis values
 *  and at the size `faces` gives its family list, weight, slant and width,
 *  and answering a face's metrics as its rule has them. */
export function fontAxes(engine: FontsLike, faces: FaceSettings): FontsLike {
  const laid = withLayout(engine, (content, style, options) => {
    if (!faces.active || !Array.isArray(content)) {
      return engine.layout(content, style, options);
    }
    let runs: DocumentRun[] | null = null;
    // the face of overridden lines every run is in, at one size, or null
    let lined: FaceRuleMetrics | null = null;
    let linedSize = NaN;
    for (let i = 0; i < content.length; i += 1) {
      const run = content[i];
      const family = run.family ?? style.family;
      const weight = run.weight ?? style.weight ?? 400;
      const stretch = run.stretch ?? style.stretch ?? 100;
      const setting =
        typeof family === 'string'
          ? faces.setting(
              family,
              numeric(weight),
              (run.style ?? style.style) === 'italic',
              typeof stretch === 'number' ? stretch : 100,
            )
          : null;
      const metrics = setting?.metrics ?? null;
      const size = run.size ?? style.size;
      if (i === 0 && metrics && overrides(metrics)) {
        lined = metrics;
        linedSize = typeof size === 'number' ? size * metrics.scale : NaN;
      } else if (lined && (metrics !== lined || size !== content[0].size)) {
        lined = null;
      }
      if (!setting) continue;
      const set: DocumentRun & { variations?: object } = { ...run };
      if (setting.family !== family) set.family = setting.family;
      if (setting.variations) set.variations = setting.variations;
      const scale = metrics?.scale ?? 1;
      if (scale !== 1 && typeof size === 'number') set.size = size * scale;
      runs ??= content.slice();
      runs[i] = set;
    }
    if (!lined || !runs || !(linedSize > 0)) {
      return engine.layout(runs ?? content, style, options);
    }
    return linedLayout(engine, runs, style, options, lined, linedSize);
  });
  const match: FontsLike['match'] = (family, style) => {
    const setting = faces.active
      ? faces.setting(
          family,
          numeric(style.weight ?? 400),
          style.style === 'italic',
          100,
        )
      : null;
    const face = engine.match(setting?.family ?? family, style);
    return setting?.metrics ? withMetrics(face, setting.metrics) : face;
  };
  return new Proxy(laid, {
    get(target, key) {
      if (key === 'match') return match;
      return Reflect.get(target, key, target);
    },
  });
}

/** Whether a rule overrides any of a face's line metrics. */
function overrides(rule: FaceRuleMetrics): boolean {
  return rule.ascent !== null || rule.descent !== null || rule.lineGap !== null;
}

/**
 * Text in one face whose rule overrides its line metrics, at one size: laid
 * out in lines as tall as the overridden metrics make them, which say where
 * the text stands on its line. The engine scales its own natural line height
 * by the multiplier it is handed, which the layout worked out against the
 * overridden one (`lineHeightMultiplier`), so the multiplier is made the
 * engine's; and its lines' ascent and descent, which the layout places
 * text by (`lineAscent`), are the rule's. Content of more than one face is
 * laid out as the engine sets it.
 */
function linedLayout(
  engine: FontsLike,
  runs: DocumentRun[],
  style: Record<string, unknown>,
  options: Parameters<FontsLike['layout']>[2],
  rule: FaceRuleMetrics,
  size: number,
): ReturnType<FontsLike['layout']> {
  const first = runs[0];
  let own: FaceMetrics;
  try {
    own = engine
      .match(String(first.family ?? style.family), {
        size,
        weight: first.weight ?? style.weight,
        style: first.style ?? style.style,
      })
      .metrics(size);
  } catch {
    return engine.layout(runs, style, options);
  }
  const ascent = rule.ascent === null ? own.ascent : rule.ascent * size;
  const descent = rule.descent === null ? own.descent : rule.descent * size;
  const gap =
    rule.lineGap === null
      ? (own.lineGap ?? own.leading ?? 0)
      : rule.lineGap * size;
  const natural = naturalOf(own);
  const wanted = ascent + descent + (Number.isFinite(gap) ? gap : 0);
  if (!(natural > 0)) return engine.layout(runs, style, options);
  const layout = engine.layout(runs, style, {
    ...options,
    lineHeight: ((options.lineHeight ?? 1) * wanted) / natural,
  });
  let lines: typeof layout.lines | null = null;
  return new Proxy(layout, {
    get(target, key) {
      if (key === 'lines') {
        lines ??= target.lines.map((line) => ({ ...line, ascent, descent }));
        return lines;
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A face's own line height (`faceLineHeight`, which this is below). */
function naturalOf(m: FaceMetrics): number {
  if (typeof m.lineHeight === 'number' && Number.isFinite(m.lineHeight)) {
    return m.lineHeight;
  }
  const gap = m.lineGap ?? m.leading ?? 0;
  return m.ascent + m.descent + (Number.isFinite(gap) ? gap : 0);
}

function numeric(weight: unknown): number {
  return typeof weight === 'number'
    ? weight
    : (NUMERIC[weight as string] ?? 400);
}

type Face = ReturnType<FontsLike['match']>;

/** A face that answers its metrics as a rule has them: its own at the size
 *  scaled, each the rule overrides a fraction of that size, and the line
 *  height theirs together. */
function withMetrics(face: Face, rule: FaceRuleMetrics): Face {
  return new Proxy(face, {
    get(target, key) {
      if (key !== 'metrics') {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (size: number): FaceMetrics => {
        const scaled = size * rule.scale;
        const own = target.metrics(scaled);
        // a face its rule only scales has the lines it has at that size
        if (rule.ascent === null && rule.descent === null) {
          if (rule.lineGap === null) return own;
        }
        const ascent = rule.ascent === null ? own.ascent : rule.ascent * scaled;
        const descent =
          rule.descent === null ? own.descent : rule.descent * scaled;
        const gap =
          rule.lineGap === null
            ? (own.lineGap ?? own.leading ?? 0)
            : rule.lineGap * scaled;
        return {
          ...own,
          ascent,
          descent,
          lineGap: gap,
          leading: gap,
          lineHeight: ascent + descent + (Number.isFinite(gap) ? gap : 0),
        };
      };
    },
  });
}
