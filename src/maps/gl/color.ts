// CSS colours as the floats GL takes.
//
// A local parser rather than ntk's `cssColorStraight`: that one is exported
// by ntk at runtime but not declared by `react-x11/ntk`'s types, and a map
// style is written in the three forms below in practice — the default
// palettes use nothing else. An unknown colour is `null`, and the layer that
// asked for it draws nothing rather than drawing black.

/** Straight (unassociated) `[r, g, b, a]`, each in `0..1`. */
export type Rgba = readonly [number, number, number, number];

const NAMED: Record<string, Rgba> = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [1, 1, 1, 1],
};

function hex(value: string): Rgba | null {
  const h = value.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  if (h.length === 3 || h.length === 4) {
    const c = (i: number) => parseInt(h[i] + h[i], 16) / 255;
    return [c(0), c(1), c(2), h.length === 4 ? c(3) : 1];
  }
  if (h.length === 6 || h.length === 8) {
    const c = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255;
    return [c(0), c(1), c(2), h.length === 8 ? c(3) : 1];
  }
  return null;
}

function functional(value: string): Rgba | null {
  const m = /^rgba?\(([^)]*)\)$/i.exec(value);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (p: string) =>
    p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255;
  const alpha = (p: string | undefined) =>
    p === undefined ? 1 : p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p);
  const out: Rgba = [
    channel(parts[0]),
    channel(parts[1]),
    channel(parts[2]),
    alpha(parts[3]),
  ];
  return out.every((c) => Number.isFinite(c)) ? out : null;
}

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim();
  if (v.startsWith('#')) return hex(v);
  return NAMED[v.toLowerCase()] ?? functional(v);
}

/** Premultiplied, with an extra opacity folded in — what the renderer's
 *  `ONE, ONE_MINUS_SRC_ALPHA` blend wants. */
export function premultiplied(color: Rgba, opacity = 1): Rgba {
  const a = color[3] * opacity;
  return [color[0] * a, color[1] * a, color[2] * a, a];
}
