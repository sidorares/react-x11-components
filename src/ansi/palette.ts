// The palette, and what a span's two colours resolve to. Pure — no theme, no
// element, no React — so every rule below is asserted directly.
//
// This is the second half of the "colour is intent, not pixels" split the
// parser makes: `./sgr.ts` records that a program asked for ANSI 2, and this
// is where a palette decides which pixels that is. Keeping them apart is what
// lets one parsed capture render against a light theme and a dark one.
//
// **`../terminal/vt/colors.ts` is the other copy of the ANSI table**, and the
// two are deliberately not shared today: that one is a component's internals,
// and a shared module may not reach into a component. The phase-2 promotion in
// `docs/prd-terminal-output.md` moves the cell grid out to a shared module,
// and the merge direction is *this* file — the grid renderer depends on the
// ANSI colour model, never the reverse.
import type { AnsiColor } from './sgr.js';

/** A colour as a packed `0xRRGGBB`, the way the arithmetic below wants it. */
export type Rgb = number;

/**
 * The standard 16 — xterm's own defaults, which is what an application's
 * colour choices were made against.
 */
export const ANSI_16: readonly Rgb[] = [
  0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd,
  0xe5e5e5, 0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff,
  0x00ffff, 0xffffff,
];

export interface AnsiPalette {
  /** 256 entries: the 16 ANSI, the 6×6×6 cube, the 24 greys. */
  readonly colors: Int32Array;
  readonly foreground: Rgb;
  readonly background: Rgb;
  /** Bold promotes ANSI 0–7 to 8–15, which is how most colour schemes were
   *  designed to be read. */
  readonly brightBold: boolean;
}

export interface AnsiPaletteOptions {
  /** The default ink. A CSS colour; anything unparseable keeps the default
   *  rather than painting something arbitrary. */
  foreground?: string;
  background?: string;
  /** ANSI 0–15, sparse — an entry left out keeps the standard colour. */
  palette?: readonly (string | undefined)[];
  /** Default true. */
  brightBold?: boolean;
}

/** The names a terminal colour prop plausibly carries. Not CSS's whole list. */
const NAMED: Readonly<Record<string, Rgb>> = {
  black: 0x000000,
  white: 0xffffff,
  red: 0xff0000,
  green: 0x008000,
  blue: 0x0000ff,
  yellow: 0xffff00,
  cyan: 0x00ffff,
  magenta: 0xff00ff,
  gray: 0x808080,
  grey: 0x808080,
};

/**
 * `#rgb`, `#rrggbb`, `rgb(…)` and the handful of names above.
 *
 * `null` for anything else, and every caller keeps its default rather than
 * guessing — a theme token that did not resolve should look like the theme,
 * not like black.
 */
export function parseCssColor(value: string | undefined): Rgb | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0]! + hex[0]!, 16);
      const g = Number.parseInt(hex[1]! + hex[1]!, 16);
      const b = Number.parseInt(hex[2]! + hex[2]!, 16);
      if (Number.isNaN(r + g + b)) return null;
      return (r << 16) | (g << 8) | b;
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = Number.parseInt(hex.slice(0, 6), 16);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part: string): number => {
      const n = part.endsWith('%')
        ? (Number.parseFloat(part) * 255) / 100
        : Number.parseFloat(part);
      return Number.isFinite(n)
        ? Math.max(0, Math.min(255, Math.round(n)))
        : -1;
    };
    const r = channel(parts[0]!);
    const g = channel(parts[1]!);
    const b = channel(parts[2]!);
    if (r < 0 || g < 0 || b < 0) return null;
    return (r << 16) | (g << 8) | b;
  }
  return NAMED[text] ?? null;
}

/** `#rrggbb`, which is what a `<richtext>` run takes. */
export function cssColor(rgb: Rgb): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Mix towards `b`, `t` in 0..1 — what `dim` uses. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const lerp = (shift: number): number => {
    const av = (a >> shift) & 0xff;
    const bv = (b >> shift) & 0xff;
    return Math.round(av + (bv - av) * t);
  };
  return (lerp(16) << 16) | (lerp(8) << 8) | lerp(0);
}

/**
 * The 256-colour palette.
 *
 * 0–15 come from `palette` where it has an entry and from the standard set
 * where it does not; 16–231 are the 6×6×6 cube and 232–255 the 24 greys, both
 * fixed by the protocol rather than by taste.
 */
export function ansiPalette(options: AnsiPaletteOptions = {}): AnsiPalette {
  const colors = new Int32Array(256);
  for (let i = 0; i < 16; i++) {
    colors[i] = parseCssColor(options.palette?.[i]) ?? ANSI_16[i]!;
  }
  const cube = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    const r = cube[Math.floor(i / 36) % 6]!;
    const g = cube[Math.floor(i / 6) % 6]!;
    const b = cube[i % 6]!;
    colors[16 + i] = (r << 16) | (g << 8) | b;
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    colors[232 + i] = (v << 16) | (v << 8) | v;
  }
  return {
    colors,
    foreground: parseCssColor(options.foreground) ?? 0xe6e6e6,
    background: parseCssColor(options.background) ?? 0x101014,
    brightBold: options.brightBold ?? true,
  };
}

/** What a span is actually painted in. */
export interface ResolvedAnsiColors {
  fg: string;
  /**
   * Absent means "whatever is behind" — the page, the block's own fill.
   *
   * The distinction is the whole reason a log can sit inside a document: text
   * in the default background must not paint a rectangle, or every line
   * becomes an opaque strip and the block stops being part of the page.
   */
  bg?: string;
}

/** The attribute slice the resolution reads — the six fields of an
 *  `AnsiAttrs` that can change a colour, and nothing else. */
export interface AnsiColorAttrs {
  readonly fg?: AnsiColor;
  readonly bg?: AnsiColor;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly inverse?: boolean;
  readonly conceal?: boolean;
}

function rgbOf(color: AnsiColor, palette: AnsiPalette): Rgb {
  return color.kind === 'rgb'
    ? color.value & 0xffffff
    : palette.colors[Math.max(0, Math.min(255, color.index))]!;
}

/**
 * A span's two colours, after every transform that can change them.
 *
 * The order is the one every terminal agrees on, and it is the same order
 * `../terminal/vt/colors.ts` applies to a live cell — bright-bold, dim,
 * inverse, conceal — so a capture and the program that produced it look the
 * same in one window.
 */
export function resolveAnsiColors(
  attrs: AnsiColorAttrs,
  palette: AnsiPalette,
): ResolvedAnsiColors {
  const fgColor = attrs.fg;
  const bgColor = attrs.bg;
  let fg = fgColor ? rgbOf(fgColor, palette) : palette.foreground;
  let bg = bgColor ? rgbOf(bgColor, palette) : palette.background;
  /** Nothing has claimed the background yet, so the surface keeps it. */
  let bare = bgColor === undefined;

  if (
    attrs.bold &&
    palette.brightBold &&
    fgColor?.kind === 'ansi' &&
    fgColor.index < 8
  ) {
    fg = palette.colors[fgColor.index + 8]!;
  }
  if (attrs.dim) fg = mixRgb(fg, bg, 0.5);
  if (attrs.inverse) {
    const swap = fg;
    fg = bg;
    bg = swap;
    // An inverted run paints its background even when neither colour was set:
    // that is the entire visible effect of SGR 7.
    bare = false;
  }
  if (attrs.conceal) fg = bg;

  return bare ? { fg: cssColor(fg) } : { fg: cssColor(fg), bg: cssColor(bg) };
}
