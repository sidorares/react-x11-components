// Cell metrics and glyphs.
//
// A terminal bypasses text shaping by construction: the grid decides where
// every glyph goes, so there are no ligatures, no kerning and no cluster
// positioning to compute — which is exactly what makes the fast path fast.
// ntk's public seam for that is `Font.glyphIdFor(cp)` plus the documented
// `drawGlyphs` run contract (ntk#254): a cmap lookup and a hand-built run,
// no shaping anywhere.
//
// The one case that does need shaping is a cluster — a base letter with
// combining marks, a text-presentation emoji with a variation selector — and
// `Font.shape()` handles those one cluster at a time, cached, on a path a
// normal screen never touches.
//
// Not every backend's text engine has those seams. react-x11's Cocoa backend
// (2.3.x) answers `fonts.match()` with a face that has `metrics` and
// `hasGlyph` and nothing else — sidorares/react-x11#432 is that engine
// growing the rest — so everything here feature-detects (`hasGlyphRuns`),
// and a `FontSet` over such an engine is a valid object that builds no runs
// rather than a `TypeError` thrown from inside paint.

/** What every backend's face answers: metrics and coverage. */
export interface EngineFont {
  metrics(size: number): FontMetrics;
  hasGlyph(codepoint: number): boolean;
}

/**
 * `metrics(size)` as the two engines report it. ntk gives `lineGap` and
 * `lineHeight`; CoreText's name for the gap is `leading`, and it reports no
 * line height at all — `lineHeightOf` reads whichever is there.
 */
export interface FontMetrics {
  ascent: number;
  descent: number;
  lineGap?: number;
  lineHeight?: number;
  leading?: number;
}

/** ntk's `Font`: the glyph-run seams on top of the metrics (ntk#254). */
export interface NtkFont extends EngineFont {
  advanceOf(glyphId: number, size: number): number;
  /** ntk#254 — the lookup twin of `hasGlyph`, `null` when uncovered. */
  glyphIdFor(codepoint: number): number | null;
  shape(
    text: string,
    size: number,
    opts?: Record<string, unknown>,
  ): { glyphs: { id: number; ax: number; dx: number; dy: number }[] };
}

/**
 * ntk's font manager, off `app.fonts` — or another engine's, which may
 * answer plainer faces and have no `fallbackFor` at all.
 */
export interface NtkFonts {
  match(
    family: string,
    opts?: { weight?: number | string; style?: string },
  ): EngineFont;
  fallbackFor?(
    codepoint: number,
    family?: string,
    opts?: { weight?: number | string; style?: string },
  ): EngineFont | null;
}

/**
 * Whether a face can build glyph runs: `glyphIdFor` to find the glyph and
 * `advanceOf` to measure it. A face without them still answers metrics and
 * coverage, which is all react-x11's Cocoa backend offers today.
 */
export function hasGlyphRuns(
  font: EngineFont | null | undefined,
): font is NtkFont {
  const f = font as Partial<NtkFont> | null | undefined;
  return (
    !!f &&
    typeof f.glyphIdFor === 'function' &&
    typeof f.advanceOf === 'function'
  );
}

/** One glyph run, in the shape `ctx.drawGlyphs` documents. */
export interface GlyphRun {
  font: NtkFont;
  size: number;
  glyphs: { id: number; ax: number; dx: number; dy: number }[];
}

export const VARIANTS = ['regular', 'bold', 'italic', 'boldItalic'] as const;
export type Variant = (typeof VARIANTS)[number];

export interface CellMetrics {
  /** Integers, because the grid, the copy band and the fill rects are. */
  cellWidth: number;
  cellHeight: number;
  /** Baseline offset from the top of the cell. */
  baseline: number;
  /** Where a single underline sits, from the top of the cell. */
  underline: number;
  /** Thickness of underline/strike/overline rules. */
  ruleHeight: number;
}

/**
 * The four faces, the cell box, and the glyph cache — everything that depends
 * on the font and nothing that depends on the frame.
 *
 * Rebuilt when the family or the size changes; the node drops its mirror at
 * the same time, because every cell's pixels moved.
 */
export class FontSet {
  readonly family: string;
  readonly size: number;
  readonly metrics: CellMetrics;
  /**
   * Whether this engine's faces can build glyph runs at all.
   *
   * `false` when `match()` answered a face with metrics and coverage but
   * none of the glyph-run seams — react-x11's Cocoa backend as of 2.3.x
   * (sidorares/react-x11#432). `run()` is then always null, and the node
   * paints nothing rather than half a terminal. A box with no fonts at all
   * is a different state and stays `true`: the engine is ntk's, it just
   * matched nothing, and backgrounds still draw.
   */
  readonly glyphRuns: boolean;
  private _fonts: NtkFonts;
  private _faces = new Map<Variant, EngineFont | null>();
  /** `variant:chars` → the run to stamp, or null for "nothing to draw". */
  private _glyphs = new Map<string, GlyphRun | null>();

  constructor(fonts: NtkFonts, family: string, size: number) {
    this._fonts = fonts;
    this.family = family;
    this.size = size;

    const regular = this.face('regular');
    this.glyphRuns = regular === null || hasGlyphRuns(regular);
    const m = safeMetrics(regular, size);
    const ascent = finite(m?.ascent, size * 0.8);
    const descent = finite(m?.descent, size * 0.2);
    const lineHeight = m ? lineHeightOf(m, ascent, descent) : size * 1.2;
    // The advance of a digit is the cell width: in a monospace face every
    // glyph agrees, and in a face that is not monospace the digit is still
    // the least surprising answer.
    let advance = size * 0.6;
    if (hasGlyphRuns(regular)) {
      const gid = safeGlyphId(regular, 0x30);
      if (gid !== null) advance = safeAdvance(regular, gid, size) || advance;
    }
    const cellWidth = Math.max(1, Math.round(advance));
    const cellHeight = Math.max(1, Math.ceil(lineHeight));
    const baseline = Math.min(
      cellHeight - 1,
      Math.round(ascent + (cellHeight - ascent - descent) / 2),
    );
    this.metrics = {
      cellWidth,
      cellHeight,
      baseline,
      underline: Math.min(
        cellHeight - 1,
        baseline + Math.max(1, Math.round(size / 10)),
      ),
      ruleHeight: Math.max(1, Math.round(size / 14)),
    };
  }

  /**
   * One of the four faces. A family with no bold or no italic resolves to the
   * regular one — ntk does not synthesise either, and a fake oblique is worse
   * than an honest upright (overstrike emulation is a later, separate call).
   */
  face(variant: Variant): EngineFont | null {
    const cached = this._faces.get(variant);
    if (cached !== undefined) return cached;
    let font: EngineFont | null = null;
    try {
      font =
        this._fonts.match(this.family, {
          weight: variant === 'bold' || variant === 'boldItalic' ? 700 : 400,
          style:
            variant === 'italic' || variant === 'boldItalic'
              ? 'italic'
              : 'normal',
        }) ?? null;
    } catch {
      // no fontconfig, no fonts on the box: the caller draws backgrounds and
      // no glyphs rather than failing to paint at all
      font = null;
    }
    this._faces.set(variant, font);
    return font;
  }

  /**
   * The run for one cell's characters, or null when there is nothing to draw.
   *
   * Cached per (variant, chars) — a screen of text is a few hundred distinct
   * entries, and the cache is what keeps a full-screen redraw a matter of
   * lookups rather than cmap searches.
   */
  run(chars: string, variant: Variant): GlyphRun | null {
    if (!this.glyphRuns || !chars || chars === ' ') return null;
    // The variant never contains a colon, so the key cannot be ambiguous
    // whatever the cell holds.
    const key = `${variant}:${chars}`;
    const hit = this._glyphs.get(key);
    if (hit !== undefined) return hit;
    const run = this._build(chars, variant);
    this._glyphs.set(key, run);
    return run;
  }

  private _build(chars: string, variant: Variant): GlyphRun | null {
    const font = this.face(variant);
    if (!hasGlyphRuns(font)) return null;
    const first = chars.codePointAt(0);
    if (first === undefined) return null;
    const single = String.fromCodePoint(first).length === chars.length;

    if (single) {
      let face = font;
      let gid = safeGlyphId(face, first);
      if (gid === null) {
        // Nothing in the terminal's own face covers it — a box-drawing
        // character in a font that has none, a CJK glyph, an emoji. The
        // fallback face is a different glyphset, so it becomes its own run;
        // it still goes out in the same request as everything else.
        const fallback = this._fallback(first, variant);
        if (!fallback) return null;
        face = fallback;
        gid = safeGlyphId(face, first);
        if (gid === null) return null;
      }
      return {
        font: face,
        size: this.size,
        glyphs: [{ id: gid, ax: this.metrics.cellWidth, dx: 0, dy: 0 }],
      };
    }

    // A cluster: shape it once and keep the result. Rare enough that the
    // shaping cost never reaches a frame budget, and correct where a
    // codepoint-at-a-time walk would stack the marks on top of each other.
    if (typeof (font as Partial<NtkFont>).shape !== 'function') return null;
    try {
      const shaped = font.shape(chars, this.size);
      if (!shaped.glyphs.length) return null;
      return { font, size: this.size, glyphs: shaped.glyphs };
    } catch {
      return null;
    }
  }

  private _fallback(codepoint: number, variant: Variant): NtkFont | null {
    const fonts = this._fonts;
    if (typeof fonts.fallbackFor !== 'function') return null;
    try {
      const face = fonts.fallbackFor(codepoint, this.family, {
        weight: variant === 'bold' || variant === 'boldItalic' ? 700 : 400,
        style:
          variant === 'italic' || variant === 'boldItalic'
            ? 'italic'
            : 'normal',
      });
      return hasGlyphRuns(face) ? face : null;
    } catch {
      return null;
    }
  }
}

function safeGlyphId(font: NtkFont, codepoint: number): number | null {
  try {
    const gid = font.glyphIdFor(codepoint);
    return typeof gid === 'number' && Number.isInteger(gid) ? gid : null;
  } catch {
    return null;
  }
}

function safeAdvance(font: NtkFont, glyphId: number, size: number): number {
  try {
    return finite(font.advanceOf(glyphId, size), 0);
  } catch {
    return 0;
  }
}

function safeMetrics(
  font: EngineFont | null,
  size: number,
): FontMetrics | null {
  if (!font || typeof font.metrics !== 'function') return null;
  try {
    const m = font.metrics(size);
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/**
 * ntk's `lineHeight` when it is there; otherwise ascent + descent + gap, with
 * the gap under either engine's name.
 */
function lineHeightOf(m: FontMetrics, ascent: number, descent: number): number {
  const gap = finite(m.lineGap, finite(m.leading, 0));
  return finite(m.lineHeight, ascent + descent + gap);
}

function finite(n: number | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** `VARIANT_*` bits from `./colors.ts` to one of the four faces. */
export function variantOf(bold: boolean, italic: boolean): Variant {
  if (bold && italic) return 'boldItalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'regular';
}
