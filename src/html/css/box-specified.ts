// A box's margins, paddings and insets as `el.style` keeps them (CSSOM
// 6.7): a value a side does not take refused — a padding below nought, a
// keyword other than `auto` where a side takes it — one it takes in its
// canonical form, a unitless zero `0px`, and the shorthands set as their
// longhands and read back from them as few as say them (CSS Box Model 3,
// CSS Logical Properties 1, 4 and CSS Position 3, 3.1).
import { specifiedMath } from './math.js';
import { splitValue } from './values.js';

/** What a value of one property comes to, as `specifiedValue` answers. */
type Specify = (prop: string, value: string) => string | null | undefined;

const PHYSICAL = ['top', 'right', 'bottom', 'left'];
const BLOCK = ['block-start', 'block-end'];
const INLINE = ['inline-start', 'inline-end'];

/** Each kind of side: its longhands' prefix, and what a side takes. */
const KINDS = {
  margin: { auto: true, negative: true },
  padding: { auto: false, negative: false },
  inset: { auto: true, negative: true },
} as const;
type Kind = keyof typeof KINDS;

/** A side's longhand name: `margin-top`, or for an inset `top`. */
const sideName = (kind: Kind, side: string): string =>
  kind === 'inset' && PHYSICAL.includes(side) ? side : `${kind}-${side}`;

/** Each shorthand's longhands, in the order its value says them. */
export const BOX_SHORTHANDS: Record<string, string[]> = Object.create(null);
/** Each longhand's kind. */
const KIND_OF: Record<string, Kind> = Object.create(null);
for (const kind of Object.keys(KINDS) as Kind[]) {
  BOX_SHORTHANDS[kind] = PHYSICAL.map((s) => sideName(kind, s));
  BOX_SHORTHANDS[`${kind}-block`] = BLOCK.map((s) => sideName(kind, s));
  BOX_SHORTHANDS[`${kind}-inline`] = INLINE.map((s) => sideName(kind, s));
  for (const side of [...PHYSICAL, ...BLOCK, ...INLINE]) {
    KIND_OF[sideName(kind, side)] = kind;
  }
}

/** The properties this answers for. */
export const BOX_SPECIFIED = new Set([
  ...Object.keys(BOX_SHORTHANDS),
  ...Object.keys(KIND_OF),
]);

const CSS_WIDE = /^(inherit|initial|unset|revert|revert-layer)$/i;
const LENGTH_UNIT =
  /^(?:px|cm|mm|q|in|pt|pc|em|rem|ex|rex|ch|rch|ic|ric|cap|rcap|lh|rlh|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max)|%)$/;

/** One side's value in its canonical form; null where the side does not
 *  take it, and the token as written where it is a function this cannot
 *  say — an `anchor()`, an `anchor-size()`. */
const sideOf = (
  longhand: string,
  token: string,
  specify: Specify,
): string | null => {
  const kind = KINDS[KIND_OF[longhand]];
  const lower = token.toLowerCase();
  if (lower === 'auto') return kind.auto ? 'auto' : null;
  if (/^[a-z-]+\(/i.test(token)) {
    // an `anchor()` and its kin as `specifiedValue` says them, which ends
    // here no more; any other function as a math function, typed against
    // the side, or as written
    const out = /^anchor(?:-size)?\(/i.test(token)
      ? specify(longhand, token)
      : specifiedMath(longhand, token);
    return out === undefined ? token : out;
  }
  const m = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i.exec(
    token,
  );
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!kind.negative && n < 0) return null;
  if (!unit) return n === 0 ? '0px' : null;
  if (!LENGTH_UNIT.test(unit)) return null;
  return `${Object.is(n, -0) ? 0 : n}${unit}`;
};

/** Four sides, top first, as few as say them. */
const shortest = ([t, r, b, l]: string[]): string[] => {
  if (l !== r) return [t, r, b, l];
  if (b !== t) return [t, r, b];
  if (r !== t) return [t, r];
  return [t];
};

/** A shorthand's longhands' values from a value, or null where it does
 *  not take it: one to four sides for a box, one or two for an axis. */
const sidesOf = (
  name: string,
  value: string,
  specify: Specify,
): string[] | null => {
  const names = BOX_SHORTHANDS[name];
  if (CSS_WIDE.test(value)) return names.map(() => value.toLowerCase());
  const words = splitValue(value).filter(Boolean);
  if (!words.length || words.length > names.length) return null;
  const read = words.map((w) => sideOf(names[0], w, specify));
  if (read.some((w) => w === null)) return null;
  const v = read as string[];
  if (names.length === 2) return [v[0], v[1] ?? v[0]];
  const [t, r = t, b = t, l = r] = v;
  return [t, r, b, l];
};

/** A shorthand said from its longhands: a CSS-wide keyword where all say
 *  the same one, and '' where only some do. */
const composedOf = (values: string[]): string => {
  // a reference to a custom property is said only by what it is in
  if (values.some((x) => /var\(/i.test(x))) return '';
  const wide = values.filter((x) => CSS_WIDE.test(x));
  if (wide.length) {
    return wide.length === values.length &&
      wide.every((x) => x.toLowerCase() === wide[0].toLowerCase())
      ? wide[0].toLowerCase()
      : '';
  }
  if (values.length === 2) {
    return values[0] === values[1] ? values[0] : values.join(' ');
  }
  return shortest(values).join(' ');
};

/** A property's value in its canonical form; null where the property does
 *  not take it. */
export function boxSpecified(
  name: string,
  value: string,
  specify: Specify,
): string | null {
  // a comment is white space
  const v = value.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  if (!v) return null;
  if (BOX_SHORTHANDS[name]) {
    const sides = sidesOf(name, v, specify);
    return sides ? composedOf(sides) : null;
  }
  if (CSS_WIDE.test(v)) return v.toLowerCase();
  const words = splitValue(v).filter(Boolean);
  return words.length === 1 ? sideOf(name, words[0], specify) : null;
}

/** The longhands a shorthand sets; null for no such shorthand. A value it
 *  does not take sets each to it, which is what a caller asking only for
 *  their names reads. */
export function boxLonghands(
  name: string,
  value: string,
  specify: Specify,
): [string, string][] | null {
  const names = BOX_SHORTHANDS[name];
  if (!names) return null;
  const sides = sidesOf(name, value.trim(), specify) ?? names.map(() => value);
  return names.map((longhand, i) => [longhand, sides[i]]);
}

/** A shorthand read back from its longhands, '' where they do not make
 *  one; null for no such shorthand. */
export function boxShorthand(
  name: string,
  longhand: (name: string) => string | null,
): string | null {
  const names = BOX_SHORTHANDS[name];
  if (!names) return null;
  const values = names.map(longhand);
  if (values.some((x) => x === null)) return '';
  return composedOf(values as string[]);
}
