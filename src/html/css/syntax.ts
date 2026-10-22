// The syntax a value is held to where CSS gives it a type of its own: a
// custom function's parameters and its `returns` (CSS Mixins 1, 2.1), in
// the grammar `@property` writes (CSS Properties and Values 1, 5) — `*`,
// or components joined by `|`, each a data type in angle brackets or an
// ident, with a `+` (a space-separated list) or a `#` (a comma-separated
// one) after it.
//
// A value is checked, not computed: it is handed on as written, and the
// property it ends up in reads it as it reads any other. So the lengths
// here are measured against a context of no element's, which is enough to
// say whether `1em + 2px` is a length and nothing else is asked of them.

import {
  parseColor,
  parseLength,
  parseNumber,
  splitCommas,
  splitValue,
} from './values.js';
import type { UnitContext } from './values.js';

/** One component of a syntax: a type or an ident, and its multiplier. */
interface Component {
  /** A data type's name without its brackets — `length` — or an ident. */
  name: string;
  type: boolean;
  multiplier: '' | '+' | '#';
}

/** Components by the syntax they came from, since the few a document
 *  writes are asked again at every call. Null for a syntax that is none. */
const PARSED = new Map<string, Component[] | null>();

/** The data types a component may name (CSS Properties and Values 1, 5.1). */
const TYPES = new Set([
  'length',
  'number',
  'percentage',
  'length-percentage',
  'color',
  'image',
  'url',
  'integer',
  'angle',
  'time',
  'resolution',
  'transform-function',
  'transform-list',
  'custom-ident',
  'string',
]);

/** An ident in a syntax, or a value a `<custom-ident>` may be. */
const IDENT = /^-?(?:[_a-zA-Z]|[^\x00-\x7f])(?:[\w-]|[^\x00-\x7f])*$/;

const CSS_WIDE = /^(?:inherit|initial|unset|revert|revert-layer|default)$/i;

/** Whether `syntax` is one. */
export function validSyntax(syntax: string): boolean {
  return syntax.trim() === '*' || components(syntax) !== null;
}

/**
 * Whether `value` is of `syntax`: the universal `*` holds everything, and
 * a list of components holds a value that is one of them. A CSS-wide
 * keyword is none of them.
 */
export function matchesSyntax(value: string, syntax: string): boolean {
  if (syntax.trim() === '*') return true;
  const parts = components(syntax);
  const v = value.trim();
  if (!parts || !v || CSS_WIDE.test(v)) return false;
  return parts.some((c) => {
    if (!c.multiplier) return matchesComponent(v, c);
    const items = c.multiplier === '+' ? splitValue(v) : splitCommas(v);
    return items.length > 0 && items.every((item) => matchesComponent(item, c));
  });
}

function components(syntax: string): Component[] | null {
  const known = PARSED.get(syntax);
  if (known !== undefined) return known;
  let out: Component[] | null = [];
  for (const raw of syntax.split('|')) {
    const part = raw.trim();
    const m = /^(?:<([a-z-]+)>|([^\s<>+#]+))([+#]?)$/.exec(part);
    if (!m) {
      out = null;
      break;
    }
    const [, type, ident, multiplier] = m;
    if (type !== undefined && !TYPES.has(type)) {
      out = null;
      break;
    }
    if (ident !== undefined && (!IDENT.test(ident) || CSS_WIDE.test(ident))) {
      out = null;
      break;
    }
    // a list of lists is no syntax, and a transform list is a list already
    if (multiplier && type === 'transform-list') {
      out = null;
      break;
    }
    out.push({
      name: type ?? ident,
      type: type !== undefined,
      multiplier: multiplier as Component['multiplier'],
    });
  }
  PARSED.set(syntax, out);
  return out;
}

/** What a length is measured against here: no element's font and no
 *  viewport, which a length is a length against all the same. */
const CHECK: UnitContext = { em: 16, rem: 16, vw: 1000, vh: 1000, scale: 1 };

const NUMBER = '[+-]?(?:\\d*\\.\\d+|\\d+)(?:e[+-]?\\d+)?';
const DIMENSION = (units: string): RegExp =>
  new RegExp(`^${NUMBER}(?:${units})$`, 'i');
const ANGLE = DIMENSION('deg|grad|rad|turn');
const TIME = DIMENSION('s|ms');
const RESOLUTION = DIMENSION('dpi|dpcm|dppx|x');
const INTEGER = /^[+-]?\d+$/;
const PERCENTAGE = new RegExp(`^${NUMBER}%$`);
const MATH = /^(?:calc|min|max|clamp|round|mod|rem|abs|sign)\(/i;
const FUNCTION = /^(?:[\w-]|[^\x00-\x7f])+\(/;

function matchesComponent(value: string, c: Component): boolean {
  if (!c.type) return value === c.name;
  switch (c.name) {
    case 'length': {
      const len = parseLength(value, CHECK);
      return typeof len === 'number';
    }
    case 'percentage': {
      if (PERCENTAGE.test(value)) return true;
      const len = MATH.test(value) ? parseLength(value, CHECK) : null;
      return (
        len !== null &&
        typeof len === 'object' &&
        !len.px &&
        len.of === undefined
      );
    }
    case 'length-percentage': {
      const len = parseLength(value, CHECK);
      return len !== null && len !== 'auto';
    }
    case 'number':
      return parseNumber(value) !== null;
    case 'integer': {
      if (INTEGER.test(value)) return true;
      // a math function's integer is rounded from whatever it comes to
      return MATH.test(value) && parseNumber(value) !== null;
    }
    case 'angle':
      return (
        ANGLE.test(value) ||
        (MATH.test(value) && /deg|grad|rad|turn/i.test(value))
      );
    case 'time':
      return (
        TIME.test(value) || (MATH.test(value) && /\d(?:s|ms)\b/i.test(value))
      );
    case 'resolution':
      return RESOLUTION.test(value);
    case 'color':
      return parseColor(value) !== null;
    case 'url':
      return /^url\(/i.test(value) || /^src\(/i.test(value);
    case 'image':
      return /^(?:url|src|image-set|-webkit-image-set|cross-fade|(?:repeating-)?(?:linear|radial|conic)-gradient)\(/i.test(
        value,
      );
    case 'string':
      return /^(["'])[\s\S]*\1$/.test(value);
    case 'custom-ident':
      return IDENT.test(value) && !CSS_WIDE.test(value);
    case 'transform-function':
      return (
        FUNCTION.test(value) &&
        value.endsWith(')') &&
        splitValue(value).length === 1
      );
    case 'transform-list': {
      if (value.toLowerCase() === 'none') return false;
      const items = splitValue(value);
      return items.every((item) => FUNCTION.test(item) && item.endsWith(')'));
    }
  }
  return false;
}
