// Token styles: how the vocabulary in `types.ts` paints.
//
// Two built-in palettes, chosen for contrast against the backgrounds
// react-x11's own light and dark themes give a field. Neither is a clone of
// a licensed theme; both stay in the familiar register (keywords violet,
// strings green-in-dark / navy-in-light, comments dim italic) because a code
// editor that surprises the eye reads as broken. An app overrides per token
// type, and a value may be a `$token` into the react-x11 theme — resolved at
// paint against the editor's own `theme`, so `comment: { color: '$textMuted' }`
// follows the palette the rest of the window uses.
import type { TokenStyle, TokenStyles } from './types.js';
import { TOKEN_FALLBACK } from './types.js';

/** For light backgrounds (the default). */
export const LIGHT_TOKEN_STYLES: TokenStyles = {
  keyword: { color: '#a626a4' },
  operator: { color: '#526066' },
  variableName: { color: '#383a42' },
  typeName: { color: '#c18401' },
  propertyName: { color: '#4078f2' },
  function: { color: '#4078f2' },
  string: { color: '#50a14f' },
  string2: { color: '#2f7d3b' },
  escape: { color: '#0184bc' },
  number: { color: '#986801' },
  atom: { color: '#986801' },
  self: { color: '#e45649' },
  comment: { color: '#a0a1a7', fontStyle: 'italic' },
  meta: { color: '#a626a4' },
  punctuation: { color: '#6a737d' },
  invalid: { color: '#e45649' },
};

/** For dark backgrounds. */
export const DARK_TOKEN_STYLES: TokenStyles = {
  keyword: { color: '#c678dd' },
  operator: { color: '#9da5b4' },
  variableName: { color: '#abb2bf' },
  typeName: { color: '#e5c07b' },
  propertyName: { color: '#61afef' },
  function: { color: '#61afef' },
  string: { color: '#98c379' },
  string2: { color: '#7bae62' },
  escape: { color: '#56b6c2' },
  number: { color: '#d19a66' },
  atom: { color: '#d19a66' },
  self: { color: '#e06c75' },
  comment: { color: '#5c6370', fontStyle: 'italic' },
  meta: { color: '#c678dd' },
  punctuation: { color: '#7f848e' },
  invalid: { color: '#e06c75' },
};

/**
 * Look a token type up, walking {@link TOKEN_FALLBACK} so a theme may style
 * `string` once and have `string2`/`escape` follow. Null when nothing in the
 * chain is styled — the editor then paints plain.
 */
export function tokenStyleFor(
  styles: TokenStyles,
  type: string,
): TokenStyle | null {
  let t: string | undefined = type;
  for (let hops = 0; t !== undefined && hops < 6; hops++) {
    const style = styles[t];
    if (style) return style;
    t = TOKEN_FALLBACK[t];
  }
  return null;
}

/**
 * Is this a colour a light palette would be unreadable on? `null` when the
 * string is not a colour this can judge (`'transparent'`, a gradient, an
 * unresolved `$token`) — the caller then falls back to the next layer down
 * (the react-x11 theme's `background`).
 *
 * Judged by WCAG relative luminance, cut at 0.42 rather than 0.5 because
 * mid-grey editor themes (Solarized-ish `#657b83` neighbourhoods) read
 * better with the dark set.
 */
export function isDarkBackground(color: string | undefined): boolean | null {
  if (!color) return null;
  const rgb = parseColor(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.42;
}

function parseColor(color: string): [number, number, number] | null {
  const c = color.trim();
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(c)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (hex.length === 6 || hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
    return null;
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(c);
  if (fn) {
    return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  }
  return null;
}

/** The built-in palette for a background: dark set on dark, light set
 * otherwise. What the editor uses when no `tokenStyles` prop is given. */
export function autoTokenStyles(background: string | undefined): TokenStyles {
  return isDarkBackground(background) ? DARK_TOKEN_STYLES : LIGHT_TOKEN_STYLES;
}
