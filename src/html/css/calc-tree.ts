// A math function as a specified value serializes (CSS Values 4, 10.10 and
// 10.12): read into a calculation tree, simplified — its sums and products
// flattened, the numeric values of a unit combined, a division by a number
// made a product by its inverse, a comparison of values of one unit
// resolved — and written out with each operation's children sorted, the
// number first and what is no numeric value last. What it is for is a
// value with a function in it no calculation can see through, which
// `anchor()` is: `calc((anchor(top) + anchor(bottom)) / 2)` is
// `calc(0.5 * (anchor(top) + anchor(bottom)))`, and `size` in a
// `calc-size()`'s calculation is another (`serializeCalculation`). Nothing
// here resolves a unit into another but the absolute lengths into pixels,
// which a specified value does, and what a computed value's `dimension`
// reads.

import { parseMath, parseMathNumber } from './calc.js';

/** A calculation's node. */
type Node =
  | { t: 'num'; value: number; unit: string }
  | { t: 'other'; text: string }
  | { t: 'sum'; of: Node[] }
  | { t: 'product'; of: Node[] }
  | { t: 'negate'; of: Node }
  | { t: 'invert'; of: Node }
  | {
      t: 'fn';
      name: string;
      args: Node[];
      /** In a calculation, whose percentages are of a size: their sign is
       *  that size's, so a comparison of them waits for it. */
      sized?: boolean;
    };

/** The math functions this reads: `calc()` and the comparisons. */
const MATH_FUNCTION = /^(?:-webkit-)?(calc|min|max|clamp)\($/i;

/** And the rest of them, which a calculation may hold `size` in. */
const OTHER_MATH =
  /^(round|mod|rem|sin|cos|tan|asin|acos|atan2?|pow|sqrt|hypot|log|exp|abs|sign)\($/i;

/** `round()`'s strategy, an argument that is no calculation. */
const STRATEGY = /^(nearest|up|down|to-zero)(?=\s*,)/i;

/** Whether a `calc-size()`'s calculation has `size` in it. */
export const HAS_SIZE = /(?<![\w-])size(?![\w-])/i;

/** Pixels per one of each absolute length unit. */
const ABSOLUTE: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
};

/**
 * A math function's value as a specified value serializes, simplified, or
 * null where it is no math function this reads: what is not a number, a
 * dimension, a percentage, a parenthesized calculation or a math function
 * — an `anchor()`, say — is kept as `other`, with `other` making what is
 * in it canonical first.
 */
export function serializeMath(
  value: string,
  other: (text: string) => string = (text) => text,
): string | null {
  const parser = new Parser(value.trim(), other);
  const node = parser.math();
  if (!node || !parser.done()) return null;
  return serializeRoot(simplify(node));
}

/**
 * A `calc-size()`'s calculation or its basis as it serializes: bare, with
 * `size` kept as what no sum sees into, or null where it is none.
 * `dimension` reads a `2em` to pixels where it can: all of them, for a
 * computed value, and a specified value's absolute lengths, where a
 * relative one keeps its unit. A math function with no `size` in it comes
 * to its value where it has one. What follows a calculation that has
 * ended is left, as Blink leaves it: `size+1px` is `size`, its `+1px` being
 * a number and not an operator.
 */
export function serializeCalculation(
  value: string,
  dimension: (token: string) => number | null,
): string | null {
  const node = new Parser(value.trim(), (t) => t, dimension).calculation();
  return node && serialize(simplify(node), true);
}

/** `size` scaled and a length and a percentage added, as a calculation
 *  serializes: what an interpolation between two of them comes to. */
export function serializeLinear(size: number, px: number, pct: number): string {
  const of: Node[] = [];
  if (pct !== 0) of.push({ t: 'num', value: pct, unit: '%' });
  if (px !== 0 || (pct === 0 && size === 0)) {
    of.push({ t: 'num', value: px, unit: 'px' });
  }
  if (size !== 0) {
    of.push({
      t: 'product',
      of: [
        { t: 'num', value: size, unit: '' },
        { t: 'other', text: 'size' },
      ],
    });
  }
  return serialize(simplify({ t: 'sum', of }), true);
}

/** A math function with nothing in it to wait for, as a value; null where
 *  it comes to none. */
function folded(
  text: string,
  dimension: (token: string) => number | null,
): Node | null {
  const n = parseMathNumber(text);
  if (n !== null) return { t: 'num', value: n, unit: '' };
  const len = parseMath(text, dimension);
  if (typeof len === 'number') return { t: 'num', value: len, unit: 'px' };
  if (len === null || len === 'auto' || len.of) return null;
  const pct: Node = { t: 'num', value: len.pct, unit: '%' };
  if (!len.px) return pct;
  return { t: 'sum', of: [pct, { t: 'num', value: len.px, unit: 'px' }] };
}

class Parser {
  private at = 0;
  constructor(
    private readonly text: string,
    private readonly other: (text: string) => string,
    /** Reads a dimension where this is a `calc-size()`'s calculation. */
    private readonly dimension:
      ((token: string) => number | null) | null = null,
  ) {}

  done(): boolean {
    this.space();
    return this.at === this.text.length;
  }

  private space(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at])) {
      this.at += 1;
    }
  }

  /** A math function at the start. */
  math(): Node | null {
    this.space();
    const m = /^(?:-webkit-)?(?:calc|min|max|clamp)\(/i.exec(
      this.text.slice(this.at),
    );
    if (!m) return null;
    return this.value();
  }

  /** A sum at the start, which is a calculation. */
  calculation(): Node | null {
    return this.sum();
  }

  private sum(): Node | null {
    const first = this.product();
    if (!first) return null;
    const of = [first];
    for (;;) {
      const back = this.at;
      // an operator of a sum has white space on either side
      if (!/\s/.test(this.text[this.at] ?? '')) break;
      this.space();
      const op = this.text[this.at];
      if ((op !== '+' && op !== '-') || !/\s/.test(this.text[this.at + 1])) {
        this.at = back;
        break;
      }
      this.at += 1;
      const next = this.product();
      if (!next) return null;
      of.push(op === '-' ? { t: 'negate', of: next } : next);
    }
    return of.length === 1 ? of[0] : { t: 'sum', of };
  }

  private product(): Node | null {
    const first = this.value();
    if (!first) return null;
    const of = [first];
    for (;;) {
      const back = this.at;
      this.space();
      const op = this.text[this.at];
      if (op !== '*' && op !== '/') {
        this.at = back;
        break;
      }
      this.at += 1;
      const next = this.value();
      if (!next) return null;
      of.push(op === '/' ? { t: 'invert', of: next } : next);
    }
    return of.length === 1 ? of[0] : { t: 'product', of };
  }

  private value(): Node | null {
    this.space();
    const rest = this.text.slice(this.at);
    const num = /^[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?(%|[a-z]+)?/i.exec(rest);
    if (num) {
      this.at += num[0].length;
      const unit = (num[1] ?? '').toLowerCase();
      const value = Number(num[0].slice(0, num[0].length - unit.length));
      const px =
        unit && unit !== '%' ? this.dimension?.(`${value}${unit}`) : null;
      if (typeof px === 'number') return { t: 'num', value: px, unit: 'px' };
      return { t: 'num', value, unit };
    }
    if (rest[0] === '(') {
      this.at += 1;
      const inner = this.sum();
      this.space();
      if (!inner || this.text[this.at] !== ')') return null;
      this.at += 1;
      return inner;
    }
    const fn = /^-?[a-z][\w-]*\(/i.exec(rest);
    if (!fn) return this.word(rest);
    const math = MATH_FUNCTION.exec(fn[0]);
    const further = this.dimension ? OTHER_MATH.exec(fn[0]) : null;
    if (further) {
      const whole = this.call();
      if (whole === null) return null;
      if (!HAS_SIZE.test(whole)) {
        this.at += whole.length;
        return folded(whole, this.dimension!) ?? { t: 'other', text: whole };
      }
    }
    if (math || further) {
      this.at += fn[0].length;
      const args: Node[] = [];
      for (;;) {
        const arg = this.argument();
        if (!arg) return null;
        args.push(arg);
        this.space();
        const c = this.text[this.at];
        this.at += 1;
        if (c === ')') break;
        if (c !== ',') return null;
      }
      const name = (math ?? further)![1].toLowerCase();
      if (name === 'calc') return args.length === 1 ? args[0] : null;
      if (name === 'round') {
        // `nearest` is what a strategy left out is
        const strategy = args[0];
        if (strategy.t === 'other' && strategy.text === 'nearest') {
          args.shift();
        }
      }
      return { t: 'fn', name, args, sized: this.dimension !== null };
    }
    // a function no calculation sees into, to its closing bracket
    const text = this.call();
    if (text === null) return null;
    this.at += text.length;
    return { t: 'other', text: this.other(text) };
  }

  /** The function call at the start, to its closing bracket; null where it
   *  is not closed. */
  private call(): string | null {
    let depth = 0;
    for (let end = this.at; end < this.text.length; end += 1) {
      const c = this.text[end];
      if (c === '(') depth += 1;
      else if (c === ')' && (depth -= 1) === 0) {
        return this.text.slice(this.at, end + 1);
      }
    }
    return null;
  }

  /** A math function's argument: a calculation, or a strategy. */
  private argument(): Node | null {
    this.space();
    const word = this.dimension
      ? STRATEGY.exec(this.text.slice(this.at))
      : null;
    if (!word) return this.sum();
    this.at += word[0].length;
    return { t: 'other', text: word[0].toLowerCase() };
  }

  /** What a calculation has for a word: `size`, and the constants. */
  private word(rest: string): Node | null {
    if (!this.dimension) return null;
    const word = /^[a-z][\w-]*/i.exec(rest);
    if (!word) return null;
    this.at += word[0].length;
    switch (word[0].toLowerCase()) {
      case 'size':
        return { t: 'other', text: 'size' };
      case 'pi':
        return { t: 'num', value: Math.PI, unit: '' };
      case 'e':
        return { t: 'num', value: Math.E, unit: '' };
      default:
        return null;
    }
  }
}

/** A numeric value with its absolute length in pixels. */
function canonical(node: Node): Node {
  if (node.t !== 'num') return node;
  const px = ABSOLUTE[node.unit];
  return px && node.unit !== 'px'
    ? { t: 'num', value: node.value * px, unit: 'px' }
    : node;
}

/** CSS Values 4, 10.10, as far as values of units no layout is needed for
 *  go. */
function simplify(node: Node): Node {
  switch (node.t) {
    case 'num':
      return canonical(node);
    case 'other':
      return node;
    case 'negate': {
      const of = simplify(node.of);
      if (of.t === 'num') return { ...of, value: -of.value };
      if (of.t === 'negate') return of.of;
      if (of.t === 'sum') {
        return simplify({
          t: 'sum',
          of: of.of.map((child) => ({ t: 'negate', of: child })),
        });
      }
      return { t: 'negate', of };
    }
    case 'invert': {
      const of = simplify(node.of);
      if (of.t === 'num' && of.unit === '') {
        return { t: 'num', value: 1 / of.value, unit: '' };
      }
      if (of.t === 'invert') return of.of;
      return { t: 'invert', of };
    }
    case 'fn': {
      const args = node.args.map(simplify);
      if (args.length === 1 && (node.name === 'min' || node.name === 'max')) {
        return args[0];
      }
      const nums = args.every((a) => a.t === 'num')
        ? (args as NumNode[])
        : null;
      const unit = nums?.[0]?.unit;
      if (
        nums &&
        !(node.sized && unit === '%') &&
        nums.every((a) => a.unit === unit)
      ) {
        const v = nums.map((a) => a.value);
        if (node.name === 'min')
          return { t: 'num', value: Math.min(...v), unit: unit! };
        if (node.name === 'max')
          return { t: 'num', value: Math.max(...v), unit: unit! };
        if (node.name === 'clamp' && v.length === 3) {
          return {
            t: 'num',
            value: Math.max(v[0], Math.min(v[1], v[2])),
            unit: unit!,
          };
        }
      }
      return { ...node, args };
    }
    case 'sum': {
      const of: Node[] = [];
      for (const child of node.of.map(simplify)) {
        if (child.t === 'sum') of.push(...child.of);
        else of.push(child);
      }
      // the numeric values of a unit added up, where the first of them was
      const out: Node[] = [];
      for (const child of of) {
        const same =
          child.t === 'num'
            ? out.find(
                (n): n is NumNode => n.t === 'num' && n.unit === child.unit,
              )
            : undefined;
        if (same && child.t === 'num') same.value += child.value;
        else out.push(child.t === 'num' ? { ...child } : child);
      }
      return out.length === 1 ? out[0] : { t: 'sum', of: out };
    }
    case 'product': {
      const of: Node[] = [];
      for (const child of node.of.map(simplify)) {
        if (child.t === 'product') of.push(...child.of);
        else of.push(child);
      }
      // its numbers multiplied together
      let factor = 1;
      let numbers = 0;
      const rest: Node[] = [];
      for (const child of of) {
        if (child.t === 'num' && child.unit === '') {
          factor *= child.value;
          numbers += 1;
        } else rest.push(child);
      }
      if (!rest.length) return { t: 'num', value: factor, unit: '' };
      if (rest.length === 1 && numbers) {
        const only = rest[0];
        // a number times one numeric value, or a sum of them, is the
        // value, or the sum, scaled
        if (only.t === 'num') return { ...only, value: only.value * factor };
        if (only.t === 'sum' && only.of.every((n) => n.t === 'num')) {
          return {
            t: 'sum',
            of: (only.of as NumNode[]).map((n) => ({
              ...n,
              value: n.value * factor,
            })),
          };
        }
      }
      if (factor === 1) numbers = 0;
      if (!numbers)
        return rest.length === 1 ? rest[0] : { t: 'product', of: rest };
      return {
        t: 'product',
        of: [{ t: 'num', value: factor, unit: '' }, ...rest],
      };
    }
  }
}

type NumNode = Extract<Node, { t: 'num' }>;

/** A sum's or a product's children in the order they serialize: the
 *  number, the percentage, the dimensions by unit, then the rest as
 *  they were (CSS Values 4, 10.12, "sort a calculation's children"). */
function sorted(of: readonly Node[]): Node[] {
  const rank = (n: Node): number =>
    n.t === 'num' ? (n.unit === '' ? 0 : n.unit === '%' ? 1 : 2) : 3;
  return of
    .map((n, i) => ({ n, i }))
    .sort((a, b) => {
      const ra = rank(a.n);
      const rb = rank(b.n);
      if (ra !== rb) return ra - rb;
      if (ra === 2 && a.n.t === 'num' && b.n.t === 'num') {
        if (a.n.unit !== b.n.unit) return a.n.unit < b.n.unit ? -1 : 1;
      }
      return a.i - b.i;
    })
    .map(({ n }) => n);
}

/** A number to six significant figures, as C's `%g` writes it. */
function numberText(n: number): string {
  const r = Number(n.toPrecision(6));
  if (r === 0) return '0';
  if (!Number.isFinite(r)) return String(r).toLowerCase();
  const size = Math.abs(r);
  if (size < 1e6 && size >= 1e-4) return String(r);
  const [mantissa, exponent] = r.toExponential().split('e');
  return `${mantissa}e${exponent[0]}${exponent.slice(1).padStart(2, '0')}`;
}

/** CSS Values 4, 10.12: a numeric value or an operation in `calc()`, and
 *  anything else as itself. */
function serializeRoot(node: Node): string {
  if (node.t === 'num') return `calc(${serialize(node)})`;
  if (node.t === 'sum' || node.t === 'product') {
    return `calc(${serialize(node, true)})`;
  }
  if (node.t === 'negate' || node.t === 'invert') {
    return `calc(${serialize(node)})`;
  }
  return serialize(node);
}

function serialize(node: Node, root = false): string {
  switch (node.t) {
    case 'num':
      return `${numberText(node.value)}${node.unit}`;
    case 'other':
      return node.text;
    case 'fn':
      return `${node.name}(${node.args.map((a) => serialize(a, true)).join(', ')})`;
    case 'negate':
      return `(-1 * ${serialize(node.of)})`;
    case 'invert':
      return `(1 / ${serialize(node.of)})`;
    case 'sum': {
      const [first, ...rest] = sorted(node.of);
      let s = serialize(first);
      for (const child of rest) {
        if (child.t === 'negate') s += ` - ${serialize(child.of)}`;
        else if (child.t === 'num' && child.value < 0) {
          s += ` - ${serialize({ ...child, value: -child.value })}`;
        } else s += ` + ${serialize(child)}`;
      }
      return root ? s : `(${s})`;
    }
    case 'product': {
      const [first, ...rest] = sorted(node.of);
      let s = serialize(first);
      for (const child of rest) {
        s +=
          child.t === 'invert'
            ? ` / ${serialize(child.of)}`
            : ` * ${serialize(child)}`;
      }
      return root ? s : `(${s})`;
    }
  }
}
