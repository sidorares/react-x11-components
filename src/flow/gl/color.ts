// CSS colours as the premultiplied floats a blend of ONE, ONE_MINUS_SRC_ALPHA
// wants.
//
// Through ntk's own parser where it can be reached, because a graph's colours
// come from three places and only one of them is ours: the palette (hex and
// `rgba()`), `tint()` (`rgba()`), and an application's node and edge styles —
// which are CSS, so `red` and `hsl(...)` are fair game and the 2D renderer
// draws them. `cssColorStraight` is exported by ntk at runtime but not
// declared by `react-x11/ntk`'s types, so it is probed rather than imported,
// the way `src/flow/index.ts` probes the reconciler's escape hatch; the local
// parser below is what a core that drops it degrades to.
import * as ntk from 'react-x11/ntk';

/** `[r, g, b, a]`, premultiplied, each in `0..1`. */
export type Rgba = readonly [number, number, number, number];

const CLEAR: Rgba = [0, 0, 0, 0];

type Parser = (value: string) => readonly number[] | null;

const ntkParser: Parser | null = (() => {
  const candidate = (ntk as unknown as { cssColorStraight?: unknown })
    .cssColorStraight;
  return typeof candidate === 'function' ? (candidate as Parser) : null;
})();

/** Hex and `rgb()`/`rgba()` — every colour the default palette produces. */
function localParse(value: string): readonly number[] | null {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return [0, 0, 0, 0];
  if (v.startsWith('#')) {
    const h = v.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
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
  const m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (p: string) =>
    p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255;
  const alpha =
    parts[3] === undefined
      ? 1
      : parts[3].endsWith('%')
        ? parseFloat(parts[3]) / 100
        : parseFloat(parts[3]);
  return [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
}

/**
 * A colour cache. A frame asks for the same few colours thousands of times —
 * every edge in one pen, every card in one fill — so parsing is once per
 * distinct string, and the cache is bounded against an application that
 * generates colours.
 */
export class ColorCache {
  private readonly map = new Map<string, Rgba>();

  get(value: string | undefined): Rgba {
    if (!value) return CLEAR;
    let rgba = this.map.get(value);
    if (rgba) return rgba;
    const parsed = (ntkParser ?? localParse)(value) ?? localParse(value);
    // An unknown colour draws nothing rather than black: the same answer
    // the 2D context gives a `fillStyle` it cannot read.
    if (!parsed) {
      rgba = CLEAR;
    } else {
      const a = parsed[3] ?? 1;
      rgba = [parsed[0] * a, parsed[1] * a, parsed[2] * a, a];
    }
    if (this.map.size > 512) this.map.clear();
    this.map.set(value, rgba);
    return rgba;
  }
}
