// What a canvas's 2d context asks of the text engine. A canvas's pixels are
// the page realm's (`scripts/raster.ts`), so text cannot be drawn on them from
// here: a context's text goes through the realm's compositor like any shape,
// and all this answers is what a string measures and how much of each pixel
// it covers.
//
// `layout.coverage()` is that answer on every engine, which is what it was
// made for: text drawn where a 2d context is not. The realm sets a string
// finer than it draws it, so that one raster can be drawn at any fraction of
// a pixel and through any matrix (`canvasRaster` in `dom.ts`).

import { canvasFontText } from './computed.js';
import { fontQuery } from './css/style.js';
import type { Cascade } from './css/cascade.js';
import type { ComputedStyle } from './css/style.js';
import type { Element } from './dom.js';
import type { WebFonts } from './fonts.js';
import { fontOf } from './layout/inline.js';
import type { FontsLike } from './layout/inline.js';
import { SDF_CUTOFF, distanceField } from '../internal/sdf.js';

/** What the element a canvas is drawn by lends it. */
export interface CanvasTextHost {
  fonts(): FontsLike | null;
  cascade(): Cascade | null;
  styleOf(element: Element): ComputedStyle | null;
  readonly webFonts: WebFonts;
}

/** How a context sets a string, which no font says. */
export interface TextSetting {
  direction: 'ltr' | 'rtl';
  /** In CSS pixels, as is `wordSpacing`. */
  letterSpacing: number;
  wordSpacing: number;
  /** The `font-kerning` of the context: 'none' turns it off. */
  kerning: string;
  /** `fontVariantCaps`' OpenType feature, or null. */
  caps: string | null;
}

/** The font's lengths at a size. */
interface FontLengths {
  ascent: number;
  descent: number;
  emAscent: number;
  emDescent: number;
}

/** A string's coverage (`layout.coverage`), a byte a pixel. */
export interface TextRaster extends FontLengths {
  width: number;
  height: number;
  data: Uint8Array;
  /** Where the string's start on its baseline is in the raster. */
  x: number;
  y: number;
  /** How far the string advances, at this raster's size. */
  advance: number;
}

/** What a canvas's font comes to: as its context reads it, and its size. */
export interface CanvasFont {
  text: string;
  size: number;
}

/** The slice of a text layout this reads. Structural, as ever. */
interface CoveredLayout {
  width: number;
  lines?: readonly { baseline: number }[];
  coverage?(options: { pad: number }): {
    width: number;
    height: number;
    data: Uint8Array;
  } | null;
}

/** As many fonts as a chart or a page of a document uses, and a bound on a
 *  page that makes a new one for each string. */
const STYLES_KEPT = 256;

export class CanvasText {
  private _host: CanvasTextHost;
  /** What each font a context set came to, while the faces hold still. */
  private _styles = new Map<string, ComputedStyle>();
  private _stylesAt = -1;

  constructor(host: CanvasTextHost) {
    this._host = host;
  }

  /** Moves as what a family comes to does, which a realm keeps its rasters
   *  by: a face that lands changes what the same string looks like. */
  get generation(): number {
    return this._host.webFonts.generation;
  }

  /** The direction a context with `direction: inherit` sets text in. */
  direction(element: Element | null): 'ltr' | 'rtl' {
    const style = element && this._host.styleOf(element);
    return style?.direction === 'rtl' ? 'rtl' : 'ltr';
  }

  /** A context's `font` set, against its canvas: null for what is no font,
   *  which the context ignores. */
  font(value: string, element: Element | null): CanvasFont | null {
    const cascade = this._host.cascade();
    if (!cascade) return null;
    const parent = element ? this._host.styleOf(element) : null;
    const style = cascade.canvasFont(value, parent);
    if (!style) return null;
    return { text: canvasFontText(style), size: style.fontSize };
  }

  /** What a font a context holds comes to now, which a face landing moves,
   *  and each `font` is written out in absolute lengths. */
  private _style(font: string): ComputedStyle | null {
    const generation = this.generation;
    if (this._stylesAt !== generation || this._styles.size >= STYLES_KEPT) {
      this._styles.clear();
      this._stylesAt = generation;
    }
    let style = this._styles.get(font);
    if (!style) {
      style = this._host.cascade()?.canvasFont(font, null) ?? undefined;
      if (style) this._styles.set(font, style);
    }
    return style ?? null;
  }

  /** Text drawn in a face of the document's asks for the face, as a style
   *  does, and is drawn in what the list has until it lands. */
  private _want(font: string, text: string): void {
    const query = fontQuery(font);
    if (!query) return;
    const fonts = this._host.webFonts;
    const { keys } = fonts.match(
      query.families,
      query.weight,
      query.italic,
      query.stretch,
      text,
    );
    if (keys.length) void fonts.load(keys);
  }

  /** A string laid out in one line at `size`. */
  private _layout(
    fonts: FontsLike,
    style: ComputedStyle,
    text: string,
    size: number,
    setting: TextSetting,
  ): CoveredLayout {
    const scale = size / style.fontSize;
    const face = { ...fontOf(style), size };
    const features: Record<string, number> = {};
    if (setting.kerning === 'none') features.kern = 0;
    if (setting.caps) features[setting.caps] = 1;
    const shared = {
      ...face,
      ...(Object.keys(features).length ? { features } : {}),
    };
    const letter = setting.letterSpacing * scale;
    const word = setting.wordSpacing * scale;
    // word spacing is no property of a run, so each space is a run of its
    // own with the difference added to it
    const pieces = word ? text.split(/( )/).filter(Boolean) : [text];
    const runs = pieces.map((piece) => {
      const spacing = letter + (word && piece === ' ' ? word : 0);
      return {
        ...shared,
        text: piece,
        ...(spacing ? { letterSpacing: spacing } : {}),
      };
    });
    return fonts.layout(runs, face, {
      wrap: false,
      direction: setting.direction,
    }) as unknown as CoveredLayout;
  }

  /** A font's own lengths, as a browser reads them off the face: the em
   *  square shares out the font's ascent and descent. */
  private _lengths(
    fonts: FontsLike,
    style: ComputedStyle,
    size: number,
  ): FontLengths {
    const face = { ...fontOf(style), size };
    const { ascent, descent } = fonts
      .match(face.family ?? '', face)
      .metrics(size);
    const both = ascent + descent;
    const emAscent = both > 0 ? (size * ascent) / both : size * 0.8;
    return { ascent, descent, emAscent, emDescent: size - emAscent };
  }

  /** How far a string runs, its width kept beyond what an engine counts of
   *  the spaces a line ends on. */
  private _width(
    fonts: FontsLike,
    style: ComputedStyle,
    layout: CoveredLayout,
    text: string,
    size: number,
    setting: TextSetting,
  ): number {
    if (text.length === text.trimEnd().length) return layout.width;
    const whole = this._layout(fonts, style, `${text}.`, size, setting);
    const dot = this._layout(fonts, style, '.', size, setting);
    return Math.max(layout.width, whole.width - dot.width);
  }

  /** What `measureText` reads of a string, at the font's size. */
  measure(
    font: string,
    text: string,
    setting: TextSetting,
  ): (FontLengths & { width: number }) | null {
    const fonts = this._host.fonts();
    const style = this._style(font);
    if (!fonts || !style) return null;
    this._want(font, text);
    const size = style.fontSize;
    const lengths = this._lengths(fonts, style, size);
    if (!text) return { ...lengths, width: 0 };
    const layout = this._layout(fonts, style, text, size, setting);
    const width = this._width(fonts, style, layout, text, size, setting);
    return { ...lengths, width };
  }

  /**
   * A string's coverage set at `size`, which is in the raster's pixels, or
   * its stroke's where `stroke` is a pen's width in them. Null where the
   * engine sets no coverage.
   */
  raster(
    font: string,
    text: string,
    size: number,
    setting: TextSetting,
    stroke: number,
  ): TextRaster | null {
    const fonts = this._host.fonts();
    const style = this._style(font);
    if (!fonts || !style) return null;
    this._want(font, text);
    const layout = this._layout(fonts, style, text, size, setting);
    const pad = Math.ceil(size / 2 + stroke) + 2;
    const covered = layout.coverage?.({ pad });
    if (!covered) return null;
    const lengths = this._lengths(fonts, style, size);
    return {
      ...lengths,
      width: covered.width,
      height: covered.height,
      data: stroke
        ? strokeOf(covered.data, covered.width, covered.height, stroke)
        : covered.data,
      x: pad,
      y: pad + (layout.lines?.[0]?.baseline ?? lengths.ascent),
      advance: this._width(fonts, style, layout, text, size, setting),
    };
  }
}

/**
 * The band of a pen of width `pen` along a coverage's edges, from its distance
 * field. An engine hands over no outlines on every backend, so a join here
 * is round whatever the context's is, and no dash is drawn.
 */
function strokeOf(
  alpha: Uint8Array,
  width: number,
  height: number,
  pen: number,
): Uint8Array {
  const half = pen / 2;
  // a field reaches a quarter as far inside as out, and each has to reach
  // past the pen's edge
  const radius = (half + 1) / SDF_CUTOFF;
  const field = distanceField(alpha, width, height, radius, 1, 0);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i += 1) {
    const distance = radius * (1 - field[i] / 255 - SDF_CUTOFF);
    const reach = half + 0.5 - Math.abs(distance);
    out[i] = reach >= 1 ? 255 : reach <= 0 ? 0 : reach * 255;
  }
  return out;
}
