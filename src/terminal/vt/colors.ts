// The palette, and what a cell's two colours resolve to. Pure — no X, no
// emulator, no node — so every rule below is asserted directly.
//
// `colors.palette` finally works fully here: urxvt takes its ANSI colours
// from the X resource database and alacritty from a config file, but the vt
// backend *is* the renderer, so a palette prop is simply the palette.
import type { TerminalColors } from '../backends.js';
import type { XtermCell } from './xterm.js';

/** A colour as a packed `0xRRGGBB`. The renderer never sees a string. */
export type Rgb = number;

/**
 * The standard 16, for a theme that has no opinion. xterm's own defaults,
 * which is what an application's colour choices were made against.
 */
const ANSI16: readonly Rgb[] = [
  0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd,
  0xe5e5e5, 0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff,
  0x00ffff, 0xffffff,
];

export interface Palette {
  /** 256 entries: the 16 ANSI, the 6×6×6 cube, the 24 greys. */
  readonly ansi: Int32Array;
  readonly background: Rgb;
  readonly foreground: Rgb;
  readonly cursor: Rgb;
  /** Text under the cursor. Derived from the cursor colour unless given. */
  readonly cursorText: Rgb;
  readonly selectionBackground: Rgb;
  readonly selectionForeground: Rgb;
}

/**
 * Parse the colour strings a prop or a theme carries. `#rgb`, `#rrggbb`,
 * `rgb(r, g, b)` and the handful of names a terminal palette uses; anything
 * else answers `null` and the caller keeps its default rather than painting
 * something arbitrary.
 */
export function parseColor(value: string | undefined): Rgb | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if (Number.isNaN(r + g + b)) return null;
      return (r << 16) | (g << 8) | b;
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = parseInt(hex.slice(0, 6), 16);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part: string): number => {
      const n = part.endsWith('%')
        ? (parseFloat(part) * 255) / 100
        : parseFloat(part);
      return Number.isFinite(n)
        ? Math.max(0, Math.min(255, Math.round(n)))
        : -1;
    };
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    if (r < 0 || g < 0 || b < 0) return null;
    return (r << 16) | (g << 8) | b;
  }
  const named = NAMED[text];
  return named === undefined ? null : named;
}

/** The names a terminal colour prop plausibly carries. Not CSS's whole list. */
const NAMED: Record<string, Rgb> = {
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
  transparent: 0x000000,
};

/** Mix towards `b`, `t` in 0..1 — what `dim` and the unfocused cursor use. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Build the 256-colour palette from the props and the theme.
 *
 * 0–15 come from `colors.palette` where it has an entry and from the standard
 * set where it does not; 16–231 are the 6×6×6 cube and 232–255 the 24 greys,
 * both of which are fixed by the protocol rather than by taste.
 */
export function buildPalette(colors: TerminalColors | undefined): Palette {
  const ansi = new Int32Array(256);
  for (let i = 0; i < 16; i++) {
    ansi[i] = parseColor(colors?.palette?.[i]) ?? ANSI16[i];
  }
  const cube = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    const r = cube[Math.floor(i / 36) % 6];
    const g = cube[Math.floor(i / 6) % 6];
    const b = cube[i % 6];
    ansi[16 + i] = (r << 16) | (g << 8) | b;
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    ansi[232 + i] = (v << 16) | (v << 8) | v;
  }

  const background = parseColor(colors?.background) ?? 0x101014;
  const foreground = parseColor(colors?.foreground) ?? 0xe6e6e6;
  const cursor = parseColor(colors?.cursor) ?? foreground;
  return {
    ansi,
    background,
    foreground,
    cursor,
    // Text under a block cursor: the background, so the glyph reads as a
    // hole in the block — which is what every terminal does and what keeps
    // the "two colours per cell" invariant true under the cursor too.
    cursorText: background,
    // A tint of the foreground over the background reads as a selection on
    // both a light and a dark scheme, where a fixed blue reads as one of them.
    selectionBackground: mix(background, foreground, 0.35),
    selectionForeground: foreground,
  };
}

// --- cell resolution --------------------------------------------------------

/** Attribute bits that survive colour resolution: what still has to be drawn. */
export const DECO_UNDERLINE = 1;
export const DECO_STRIKE = 2;
export const DECO_OVERLINE = 4;
/** Font variant, as two bits — the run key the glyph pass groups on. */
export const VARIANT_BOLD = 8;
export const VARIANT_ITALIC = 16;

/** How a cell is being marked out, on top of what it says. */
export interface CellState {
  selected: boolean;
  /** The cursor is on this cell, visible, and the terminal has focus. */
  cursor: 'none' | 'block' | 'underline' | 'bar' | 'hollow';
  /** `drawBoldTextInBrightColors` — bold promotes ANSI 0–7 to 8–15. */
  brightBold: boolean;
}

export interface ResolvedCell {
  fg: Rgb;
  bg: Rgb;
  /** `DECO_*` | `VARIANT_*`. */
  flags: number;
}

/**
 * A cell's two colours, after every transform that can change them.
 *
 * The order is the one every terminal agrees on, and it is what makes "two
 * colours per cell" true *after* resolution — which is the property the
 * renderer exploits: one rectangle pass grouped by background, one glyph pass
 * grouped by foreground.
 */
export function resolveCell(
  cell: XtermCell,
  palette: Palette,
  state: CellState,
  out: ResolvedCell,
): ResolvedCell {
  let fg = cell.isFgDefault()
    ? palette.foreground
    : cell.isFgRGB()
      ? cell.getFgColor() & 0xffffff
      : palette.ansi[cell.getFgColor() & 0xff];
  let bg = cell.isBgDefault()
    ? palette.background
    : cell.isBgRGB()
      ? cell.getBgColor() & 0xffffff
      : palette.ansi[cell.getBgColor() & 0xff];

  let flags = 0;
  const bold = cell.isBold() !== 0;
  if (bold) flags |= VARIANT_BOLD;
  if (cell.isItalic()) flags |= VARIANT_ITALIC;
  if (cell.isUnderline()) flags |= DECO_UNDERLINE;
  if (cell.isStrikethrough()) flags |= DECO_STRIKE;
  if (cell.isOverline()) flags |= DECO_OVERLINE;

  // Bold in a palette colour picks the bright half of the pair, which is how
  // most terminal colour schemes were designed to be read.
  if (bold && state.brightBold && cell.isFgPalette()) {
    const index = cell.getFgColor() & 0xff;
    if (index < 8) fg = palette.ansi[index + 8];
  }
  if (cell.isDim()) fg = mix(fg, bg, 0.5);
  if (cell.isInverse()) {
    const swap = fg;
    fg = bg;
    bg = swap;
  }
  if (cell.isInvisible()) fg = bg;

  if (state.selected) {
    bg = palette.selectionBackground;
    fg = palette.selectionForeground;
  }
  switch (state.cursor) {
    case 'block':
      bg = palette.cursor;
      fg = palette.cursorText;
      break;
    case 'hollow':
      // Unfocused: the classic outline. Drawn as a decoration rather than a
      // fill, so the cell keeps its own colours — see the renderer.
      break;
    default:
      break;
  }

  out.fg = fg;
  out.bg = bg;
  out.flags = flags;
  return out;
}
