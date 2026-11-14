// The background layers' properties as `el.style` keeps them (CSS
// Backgrounds 3, 3; CSS Backgrounds 4's `border-area` and the logical
// positions): a comma-separated list, a layer at a time, each in its
// canonical form as Chromium keeps it, or none for a value the property does
// not take. `background-image` and the `background` shorthand are not here.

import { serializeMath } from './calc-tree.js';
import { parseLength, splitCommas, splitValue } from './values.js';
import type { UnitContext } from './values.js';

const CHECK: UnitContext = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };
const CSS_WIDE = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const MATH = /^(?:calc|min|max|clamp|round|mod|rem|abs|sign)\(/i;
const DIMENSION = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|[a-z]+)?$/i;

const num = (n: number): string => {
  const r = Number(n.toPrecision(6));
  return Object.is(r, -0) ? '0' : String(r);
};

/** A `<length-percentage>` as kept, `0` as `0px`; with `nonNegative`, none
 *  below nought; null for none. */
function lengthPercentage(token: string, nonNegative = false): string | null {
  const t = token.trim();
  if (MATH.test(t)) {
    const v = parseLength(t, CHECK);
    if (v === null || v === 'auto') return null;
    return serializeMath(t) ?? null;
  }
  const m = DIMENSION.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (nonNegative && n < 0) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (!unit) return n === 0 ? '0px' : null;
  if (unit === '%') return `${num(n)}%`;
  if (parseLength(`1${unit}`, CHECK) === null) return null;
  return num(n) + unit;
}

/** Each layer of a list read by `layer`, joined as CSS writes a list; null
 *  where any layer is none, or the list is empty. */
function layers(
  value: string,
  layer: (words: string[]) => string | null,
): string | null {
  const parts = splitCommas(value);
  if (!parts.length) return null;
  const out: string[] = [];
  for (const part of parts) {
    const words = splitValue(part.trim()).filter(Boolean);
    if (!words.length) return null;
    const v = layer(words);
    if (v === null) return null;
    out.push(v);
  }
  return out.join(', ');
}

/** One keyword of `words`, from `set`. */
const oneOf =
  (set: ReadonlySet<string>) =>
  (words: string[]): string | null => {
    if (words.length !== 1) return null;
    const w = words[0].toLowerCase();
    return set.has(w) ? w : null;
  };

const ATTACHMENTS = new Set(['scroll', 'fixed', 'local']);
const BOXES = new Set(['border-box', 'padding-box', 'content-box']);

/** A layer's `background-clip` (Backgrounds 4, 2.3): a box, or
 *  `border-area` and `text`, either or both, `border-area` first. */
function clipOf(words: string[]): string | null {
  const w = words.map((x) => x.toLowerCase());
  if (w.length === 1 && BOXES.has(w[0])) return w[0];
  const set = new Set(w);
  if (
    set.size !== w.length ||
    ![...set].every((x) => x === 'border-area' || x === 'text')
  ) {
    return null;
  }
  return ['border-area', 'text'].filter((x) => set.has(x)).join(' ');
}

const REPEATS = new Set(['repeat', 'space', 'round', 'no-repeat']);
/** A layer's `background-repeat`: `repeat-x`, `repeat-y`, or one or two
 *  of the four, the second left out where it is the first, and a pair
 *  `repeat-x` and `repeat-y` say written as they say it. */
function repeatOf(words: string[]): string | null {
  const w = words.map((x) => x.toLowerCase());
  if (w.length === 1 && (w[0] === 'repeat-x' || w[0] === 'repeat-y'))
    return w[0];
  if (w.length > 2 || !w.every((x) => REPEATS.has(x))) return null;
  const [x, y = x] = w;
  if (x === y) return x;
  if (x === 'repeat' && y === 'no-repeat') return 'repeat-x';
  if (x === 'no-repeat' && y === 'repeat') return 'repeat-y';
  return `${x} ${y}`;
}

/** A layer's `background-size`: `cover`, `contain`, or one or two of
 *  `auto` and a length-percentage not below nought, the second `auto`
 *  where it is left out, and `auto auto` as `auto`. */
function sizeOf(words: string[]): string | null {
  const w = words.map((x) => x.toLowerCase());
  if (w.length === 1 && (w[0] === 'cover' || w[0] === 'contain')) return w[0];
  if (w.length > 2) return null;
  const v = words.map((x) =>
    x.toLowerCase() === 'auto' ? 'auto' : lengthPercentage(x, true),
  );
  if (v.some((x) => x === null)) return null;
  const [a, b = 'auto'] = v as string[];
  return a === 'auto' && b === 'auto' ? 'auto' : `${a} ${b}`;
}

const X_SIDES = new Set(['left', 'right']);
const Y_SIDES = new Set(['top', 'bottom']);

/** A layer's `background-position` (Backgrounds 3, 3.6): one to four
 *  values, as Chromium writes them back — across first, then down, a
 *  side's offset after it, and a value down the middle said `center`. */
function positionOf(words: string[]): string | null {
  const kw = (w: string): string | null => {
    const l = w.toLowerCase();
    return l === 'center' || X_SIDES.has(l) || Y_SIDES.has(l) ? l : null;
  };
  const len = (w: string): string | null =>
    kw(w) ? null : lengthPercentage(w);
  const n = words.length;
  if (n === 1) {
    const k = kw(words[0]);
    if (k) return Y_SIDES.has(k) ? `center ${k}` : `${k} center`;
    const l = len(words[0]);
    return l && `${l} center`;
  }
  if (n === 2) {
    const [a, b] = words;
    const ka = kw(a);
    const kb = kw(b);
    if (!ka && !kb) {
      const la = len(a);
      const lb = len(b);
      return la && lb ? `${la} ${lb}` : null;
    }
    if (ka && kb) {
      // either order, so long as each is on an axis of its own
      const across = X_SIDES.has(ka) || (ka === 'center' && !X_SIDES.has(kb));
      const [x, y] = across ? [ka, kb] : [kb, ka];
      if (Y_SIDES.has(x) || X_SIDES.has(y)) return null;
      return `${x} ${y}`;
    }
    // a keyword and a length: the keyword says its axis by where it is
    if (ka) {
      if (Y_SIDES.has(ka)) return null;
      const lb = len(b);
      return lb && `${ka} ${lb}`;
    }
    if (X_SIDES.has(kb!)) return null;
    const la = len(a);
    return la && `${la} ${kb}`;
  }
  if (n > 4) return null;
  // three or four: keywords, each but `center` with an offset or none
  const parts: { side: string; offset: string | null }[] = [];
  for (let i = 0; i < n; i += 1) {
    const k = kw(words[i]);
    if (!k) return null;
    const next = words[i + 1];
    const offset = next !== undefined && !kw(next) ? len(next) : null;
    if (next !== undefined && !kw(next) && offset === null) return null;
    if (offset !== null) {
      if (k === 'center') return null;
      i += 1;
    }
    parts.push({ side: k, offset });
  }
  if (parts.length !== 2 || !parts.some((p) => p.offset !== null)) return null;
  const [p, q] = parts;
  const xFirst =
    X_SIDES.has(p.side) ||
    Y_SIDES.has(q.side) ||
    (p.side === 'center' && q.side !== 'center' && !X_SIDES.has(q.side));
  const [x, y] = xFirst ? [p, q] : [q, p];
  if (Y_SIDES.has(x.side) || X_SIDES.has(y.side)) return null;
  if (x.side === 'center' && y.side === 'center') return null;
  const say = (s: { side: string; offset: string | null }): string =>
    s.offset === null ? s.side : `${s.side} ${s.offset}`;
  return `${say(x)} ${say(y)}`;
}

/** A layer's `background-position-x` or `-y` (Backgrounds 4, 2.4):
 *  `center`, a length-percentage, or a side of the axis and an offset
 *  or none. */
function axisOf(sides: ReadonlySet<string>) {
  return (words: string[]): string | null => {
    const k = words[0].toLowerCase();
    if (words.length === 1) {
      if (k === 'center' || sides.has(k)) return k;
      return lengthPercentage(words[0]);
    }
    if (words.length !== 2 || !sides.has(k)) return null;
    const l = lengthPercentage(words[1]);
    return l && `${k} ${l}`;
  };
}
const X_AXIS = axisOf(new Set(['left', 'right', 'x-start', 'x-end']));
const Y_AXIS = axisOf(new Set(['top', 'bottom', 'y-start', 'y-end']));

const READERS: Record<string, (words: string[]) => string | null> = {
  'background-attachment': oneOf(ATTACHMENTS),
  'background-origin': oneOf(BOXES),
  'background-clip': clipOf,
  'background-repeat': repeatOf,
  'background-size': sizeOf,
  'background-position': positionOf,
  'background-position-x': X_AXIS,
  'background-position-y': Y_AXIS,
};

/** A background layer property as `el.style` keeps it; undefined for a
 *  name this is not, or a value every property takes. */
export function backgroundSpecified(
  name: string,
  value: string,
): string | null | undefined {
  const read = READERS[name];
  if (!read) return undefined;
  if (CSS_WIDE.test(value.trim())) return undefined;
  return layers(value, read);
}
