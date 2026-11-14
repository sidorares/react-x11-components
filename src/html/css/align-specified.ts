// The box alignment, gap and flex properties as `el.style` keeps them
// (CSSOM 6.7): a value the property does not take refused, one it does in
// its canonical form — keywords in lower case, `first baseline` as
// `baseline`, a number as CSS serializes one, a unitless zero a length of
// `0px` — and the shorthands set as their longhands and read back from
// them as short as they can be said (CSS Box Alignment 3, CSS Flexbox 1,
// 7.1 and 5.3).
import { splitValue } from './values.js';

/** What a value of one property comes to, as `specifiedValue` answers. */
type Specify = (prop: string, value: string) => string | null | undefined;

/** A grid gap's old names, each the property it stands for. */
const GAP_ALIASES: Record<string, string> = {
  'grid-gap': 'gap',
  'grid-row-gap': 'row-gap',
  'grid-column-gap': 'column-gap',
};

/** The properties this answers for. */
export const ALIGN_SPECIFIED = new Set([
  'align-content',
  'justify-content',
  'align-items',
  'justify-items',
  'align-self',
  'justify-self',
  'place-content',
  'place-items',
  'place-self',
  'row-gap',
  'column-gap',
  'gap',
  ...Object.keys(GAP_ALIASES),
  'flex-direction',
  'flex-wrap',
  'flex-flow',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'flex',
  'order',
]);

/** Each shorthand's longhands, in the order its value says them. */
export const ALIGN_SHORTHANDS: Record<string, string[]> = {} as Record<
  string,
  string[]
>;
const LONGHANDS_OF: Record<string, string[]> = {
  'place-content': ['align-content', 'justify-content'],
  'place-items': ['align-items', 'justify-items'],
  'place-self': ['align-self', 'justify-self'],
  gap: ['row-gap', 'column-gap'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
};
Object.assign(ALIGN_SHORTHANDS, LONGHANDS_OF);

const CSS_WIDE = /^(inherit|initial|unset|revert|revert-layer)$/i;

const SELF_POSITION = new Set([
  'center',
  'start',
  'end',
  'self-start',
  'self-end',
  'flex-start',
  'flex-end',
  'flow-start',
  'flow-end',
]);
const CONTENT_POSITION = new Set([
  'center',
  'start',
  'end',
  'flex-start',
  'flex-end',
  'flow-start',
  'flow-end',
]);
const DISTRIBUTION = new Set([
  'space-between',
  'space-around',
  'space-evenly',
  'stretch',
]);

/** `[ first | last ]? baseline`, `first baseline` said as `baseline`. */
const baselineOf = (w: string[]): string | null => {
  if (w.length === 1) return w[0] === 'baseline' ? 'baseline' : null;
  if (w.length !== 2 || w[1] !== 'baseline') return null;
  return w[0] === 'first'
    ? 'baseline'
    : w[0] === 'last'
      ? 'last baseline'
      : null;
};
/** `<overflow-position>? <position>`, with `left` and `right` where the
 *  axis is the inline one. */
const positionOf = (
  w: string[],
  positions: ReadonlySet<string>,
  inline: boolean,
): string | null => {
  const ok = (word: string) =>
    positions.has(word) || (inline && (word === 'left' || word === 'right'));
  if (w.length === 1) return ok(w[0]) ? w[0] : null;
  if (w.length === 2 && (w[0] === 'safe' || w[0] === 'unsafe') && ok(w[1])) {
    return `${w[0]} ${w[1]}`;
  }
  return null;
};
/** `legacy`, alone or with `left`, `right` or `center` either side. */
const legacyOf = (w: string[]): string | null => {
  if (w.length === 1) return w[0] === 'legacy' ? 'legacy' : null;
  if (w.length !== 2) return null;
  const i = w.indexOf('legacy');
  if (i < 0) return null;
  const side = w[1 - i];
  return side === 'left' || side === 'right' || side === 'center'
    ? `legacy ${side}`
    : null;
};

/** An alignment longhand's words in their canonical form, or null. */
const alignmentOf = (name: string, w: string[]): string | null => {
  if (!w.length) return null;
  const one = w.length === 1 ? w[0] : '';
  switch (name) {
    case 'align-content':
      if (one === 'normal' || DISTRIBUTION.has(one)) return one;
      return baselineOf(w) ?? positionOf(w, CONTENT_POSITION, false);
    case 'justify-content':
      if (one === 'normal' || DISTRIBUTION.has(one)) return one;
      return positionOf(w, CONTENT_POSITION, true);
    case 'align-items':
    case 'align-self':
    case 'justify-items':
    case 'justify-self': {
      const self = name.endsWith('self');
      const inline = name.startsWith('justify');
      // `<overflow-position>? normal`
      if (
        w.length === 2 &&
        (w[0] === 'safe' || w[0] === 'unsafe') &&
        w[1] === 'normal'
      ) {
        return `${w[0]} normal`;
      }
      if (
        one === 'normal' ||
        one === 'stretch' ||
        one === 'anchor-center' ||
        (self && one === 'auto')
      ) {
        return one;
      }
      return (
        baselineOf(w) ??
        positionOf(w, SELF_POSITION, inline) ??
        (name === 'justify-items' ? legacyOf(w) : null)
      );
    }
  }
  return null;
};

/** A length or a percentage, or a unitless zero as `0px`, in its
 *  canonical form; null for anything else, and for a negative one where
 *  `nonNegative`. */
const LENGTH_UNIT =
  /^(?:px|cm|mm|q|in|pt|pc|em|rem|ex|rex|ch|rch|ic|ric|cap|rcap|lh|rlh|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max)|%)$/;
const lengthText = (token: string, nonNegative: boolean): string | null => {
  const m = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i.exec(
    token,
  );
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (nonNegative && n < 0) return null;
  if (!unit) return n === 0 ? '0px' : null;
  if (!LENGTH_UNIT.test(unit)) return null;
  return `${Object.is(n, -0) ? 0 : n}${unit}`;
};
/** A number in its canonical form, or null; a negative one only where
 *  `negative`, a fraction only where not `integer`. */
const numberText = (
  token: string,
  negative: boolean,
  integer: boolean,
): string | null => {
  const m = integer
    ? /^[+-]?\d+$/.exec(token)
    : /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.exec(token);
  if (!m) return null;
  const n = Number(token);
  if (!negative && n < 0) return null;
  return String(Object.is(n, -0) ? 0 : n);
};
/** `nowrap | [ wrap | wrap-reverse ] || balance` (CSS Flexbox 2), `wrap
 *  balance` said as `balance`, which wraps. */
const wrapOf = (w: string[]): string | null => {
  if (w.length === 1) {
    return /^(nowrap|wrap|wrap-reverse|balance)$/.test(w[0]) ? w[0] : null;
  }
  if (w.length !== 2 || !w.includes('balance')) return null;
  const other = w[0] === 'balance' ? w[1] : w[0];
  if (other === 'wrap') return 'balance';
  return other === 'wrap-reverse' ? 'wrap-reverse balance' : null;
};
/** Whether a token is a function call. */
const isFunction = (token: string): boolean => /^[a-z-]+\(/i.test(token);

/** A longhand that is one value, in its canonical form; null where the
 *  property does not take it, undefined where a function in it is one
 *  this cannot say. */
const longhandOf = (
  name: string,
  v: string,
  specify: Specify,
): string | null | undefined => {
  const lower = v.toLowerCase();
  switch (name) {
    case 'row-gap':
    case 'column-gap':
      if (lower === 'normal') return 'normal';
      if (isFunction(v)) return /^anchor/i.test(v) ? null : undefined;
      return lengthText(v, true);
    case 'flex-direction':
      return /^(row|row-reverse|column|column-reverse)$/.test(lower)
        ? lower
        : null;
    case 'flex-wrap':
      return wrapOf(lower.split(/\s+/).filter(Boolean));
    case 'flex-grow':
    case 'flex-shrink':
      if (isFunction(v)) return undefined;
      return numberText(v, false, false);
    case 'order':
      if (isFunction(v)) return undefined;
      return numberText(v, true, true);
    case 'flex-basis':
      if (
        /^(content|auto|min-content|max-content|fit-content|stretch)$/.test(
          lower,
        )
      ) {
        return lower;
      }
      if (isFunction(v)) return /^anchor/i.test(v) ? null : undefined;
      return lengthText(v, true);
  }
  // a longhand of one word or two: the alignment properties
  void specify;
  return alignmentOf(name, lower.split(/\s+/).filter(Boolean));
};

/** A flex factor or basis said by one token, through `specifiedValue`
 *  for a math function, which it types against the property. */
const flexPart = (
  name: 'flex-grow' | 'flex-basis',
  token: string,
  specify: Specify,
): string | null => {
  const out = isFunction(token)
    ? specify(name, token)
    : longhandOf(name, token, specify);
  return out === undefined ? token : out;
};

/** The longhands a shorthand sets from a value, or null where the
 *  shorthand does not take it. */
const parseShorthand = (
  name: string,
  v: string,
  specify: Specify,
): string[] | null => {
  if (CSS_WIDE.test(v)) {
    return LONGHANDS_OF[name].map(() => v.toLowerCase());
  }
  if (name === 'gap') {
    const parts = splitValue(v);
    if (!parts.length || parts.length > 2) return null;
    const values = parts.map((p) => longhandOf('row-gap', p, specify));
    if (values.some((x) => x === null)) return null;
    const out = values.map((x, i) => x ?? parts[i]) as string[];
    return [out[0], out[1] ?? out[0]];
  }
  if (name === 'flex-flow') {
    // a direction at either end, and the wrap, which may be two words, the
    // rest
    const parts = v.toLowerCase().split(/\s+/).filter(Boolean);
    const isDirection = (p: string) =>
      longhandOf('flex-direction', p, specify) !== null;
    let direction = 'row';
    let rest = parts;
    if (parts.length && isDirection(parts[0])) {
      direction = parts[0];
      rest = parts.slice(1);
    } else if (parts.length && isDirection(parts[parts.length - 1])) {
      direction = parts[parts.length - 1];
      rest = parts.slice(0, -1);
    }
    if (!parts.length || rest.some(isDirection)) return null;
    const wrap = rest.length ? wrapOf(rest) : 'nowrap';
    return wrap ? [direction, wrap] : null;
  }
  if (name === 'flex') {
    const parts = splitValue(v);
    if (parts.length === 1 && parts[0].toLowerCase() === 'none') {
      return ['0', '0', 'auto'];
    }
    if (!parts.length || parts.length > 3) return null;
    let grow: string | undefined;
    let shrink: string | undefined;
    let basis: string | undefined;
    let i = 0;
    while (i < parts.length) {
      if (grow === undefined) {
        const g = flexPart('flex-grow', parts[i], specify);
        if (g !== null) {
          grow = g;
          i += 1;
          if (i < parts.length) {
            const s = flexPart('flex-grow', parts[i], specify);
            if (s !== null) {
              shrink = s;
              i += 1;
            }
          }
          continue;
        }
      }
      if (basis === undefined) {
        const b = flexPart('flex-basis', parts[i], specify);
        if (b !== null) {
          basis = b;
          i += 1;
          continue;
        }
      }
      return null;
    }
    return [
      grow ?? '1',
      shrink ?? '1',
      basis ?? (grow === undefined ? 'auto' : '0%'),
    ];
  }
  // a place shorthand: the align value, and the justify value, which is the
  // align value again where it is not given — or `start` where that is a
  // baseline, which justify-content does not take
  const [alignName, justifyName] = LONGHANDS_OF[name];
  const w = v.toLowerCase().split(/\s+/).filter(Boolean);
  const alone = alignmentOf(alignName, w);
  if (alone) {
    const justify = alignmentOf(justifyName, w);
    if (justify) return [alone, justify];
    if (name === 'place-content' && baselineOf(w)) return [alone, 'start'];
    return null;
  }
  for (let at = 1; at < w.length; at += 1) {
    const align = alignmentOf(alignName, w.slice(0, at));
    const justify = align && alignmentOf(justifyName, w.slice(at));
    if (align && justify) return [align, justify];
  }
  return null;
};

/** A shorthand said from its longhands, as short as it can be. */
const composedOf = (name: string, values: string[]): string => {
  const wide = values.filter((x) => CSS_WIDE.test(x));
  if (wide.length) {
    return wide.length === values.length &&
      wide.every((x) => x.toLowerCase() === wide[0].toLowerCase())
      ? wide[0].toLowerCase()
      : '';
  }
  if (name === 'flex') return values.join(' ');
  if (name === 'flex-flow') {
    const [direction, wrap] = values;
    if (wrap === 'nowrap') return direction;
    return direction === 'row' ? wrap : `${direction} ${wrap}`;
  }
  return values[0] === values[1] ? values[0] : values.join(' ');
};

/** A property's value in its canonical form; null where the property does
 *  not take it, undefined where this cannot say. */
export function alignSpecified(
  prop: string,
  value: string,
  specify: Specify,
): string | null | undefined {
  const name = GAP_ALIASES[prop] ?? prop;
  // a comment is white space
  const v = value.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  if (!v) return null;
  if (LONGHANDS_OF[name]) {
    const parts = parseShorthand(name, v, specify);
    return parts ? composedOf(name, parts) : null;
  }
  if (CSS_WIDE.test(v)) return v.toLowerCase();
  return longhandOf(name, v, specify);
}

/** The longhands a shorthand sets, from its canonical form; null for no
 *  such shorthand. A value it does not take sets each longhand to it,
 *  which is what a caller asking only for their names reads. */
export function alignLonghands(
  prop: string,
  value: string,
  specify: Specify,
): [string, string][] | null {
  const name = GAP_ALIASES[prop] ?? prop;
  const names = LONGHANDS_OF[name];
  if (!names) return null;
  const parts =
    parseShorthand(name, value.trim(), specify) ?? names.map(() => value);
  return names.map((longhand, i) => [longhand, parts[i]]);
}

/** A shorthand read back from its longhands, or '' where they do not make
 *  one; null for no such shorthand. */
export function alignShorthand(
  prop: string,
  longhand: (name: string) => string | null,
): string | null {
  const name = GAP_ALIASES[prop] ?? prop;
  const names = LONGHANDS_OF[name];
  if (!names) return null;
  const values = names.map(longhand);
  if (values.some((x) => x === null)) return '';
  return composedOf(name, values as string[]);
}
