// The theme's say in how a map looks: which of the default style's palettes
// it gets, and the colours markers, overlays and the attribution fall back
// to. Both renderers read the theme through these, so a map in a dark
// application is dark whichever of them draws it.
import type { OverlayPalette } from './overlay.js';
import type { MapStyle } from './style.js';
import { shortbreadStyle } from './styles.js';

const defaults = new Map<boolean, MapStyle>();

/**
 * The style a map with no `mapStyle` is drawn in: `shortbreadStyle()` in the
 * theme's light or dark palette. Made once each — a style's identity is
 * what decides whether the GL renderer rebuilds its tiles.
 */
export function defaultStyleFor(dark: boolean): MapStyle {
  let style = defaults.get(dark);
  if (!style) {
    style = shortbreadStyle({ dark });
    defaults.set(dark, style);
  }
  return style;
}

/**
 * Whether a theme is dark — the luminance of the surface the map sits on,
 * the same reading `src/code-editor/`'s token themes make, rather than a flag
 * nobody sets. A map inside a dark application that stays light is the thing
 * everyone notices first.
 */
export function isDarkTheme(theme: unknown): boolean {
  const background = (theme as Record<string, unknown> | undefined)?.background;
  if (typeof background !== 'string') return false;
  const hex = background.trim();
  if (!hex.startsWith('#') || hex.length < 7) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** The colours a marker, an overlay and the attribution use where they do
 *  not name one. */
export function overlayPalette(theme: unknown): OverlayPalette {
  const t = theme as Record<string, unknown> | undefined;
  return {
    accent: (t?.accent as string) ?? '#2d6cdf',
    background: (t?.background as string) ?? '#ffffff',
    text: (t?.text as string) ?? '#111111',
  };
}
