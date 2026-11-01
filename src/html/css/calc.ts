// `calc()`, `min()`, `max()` and `clamp()` (CSS Values 4 10), read down to
// what a length here can hold: device pixels, or a percentage of what
// layout knows with pixels added (`Pct.px`) — every `calc()` that adds and
// scales, which is what documents write: `calc(100% - 2em)`. A comparison
// with a percentage in it, `min(100%, 600px)`, is a different sum at every
// width, and is kept as one (`Pct.of`) for layout to resolve; sums and
// scales distribute into it, so `calc(min(100%, 600px) - 2rem)` is
// `min(100% - 2rem, 600px - 2rem)`.
//
// The other math functions (10.4–10.8) — the stepped values, the
// trigonometric and exponential functions, and the signs — are worked out
// where their arguments are, and none of them where a percentage is in one,
// which is a different value at every width. Apple turns a length into a
// number with `tan(atan2(var(--w), 1px))`, the way a page does that has
// no typed division, and sized its hero by the ratio of two.

import type { Len } from './values.js';

/** A sum: a number, or a length as pixels plus a percentage. */
interface Linear {
  kind: 'linear';
  length: boolean;
  px: number;
  pct: number;
  /** A percentage was written, even where the sum cancels it: against a
   *  height nothing sets, `calc(40px + 10% - 20% / 2)` is still `auto`. */
  hasPct: boolean;
  /** An angle, in degrees, where the caller's dimension is not one: what a
   *  trigonometric function takes and an inverse one gives. */
  angle?: boolean;
}

/** `min()` or `max()` of lengths, a percentage among them. */
interface Compare {
  kind: 'compare';
  max: boolean;
  args: Term[];
}

type Term = Linear | Compare;

type Token =
  | { t: 'num'; value: number; unit: string }
  | { t: 'op'; value: '+' | '-' | '*' | '/' }
  | { t: 'open'; fn: string }
  | { t: 'close' }
  | { t: 'comma' }
  | { t: 'space' }
  | { t: 'word'; value: string };

/**
 * A math function's value as a length, or null where it is none — a
 * number, a type that does not add up, a division by zero. `dimension`
 * reads one `10px` or `2em` as this package's lengths do.
 */
export function parseMath(
  value: string,
  dimension: (token: string) => number | null,
  /** How many of what `dimension` reads a degree is, where it reads
   *  angles: a transform's, so that `rotate(atan2(1, 1))` and
   *  `sin(30deg)` are worked out in its unit. */
  angular: number | null = null,
): Len | null {
  const term = parseTerm(value, dimension, false, angular);
  if (!term || !isLength(term)) return null;
  return toLen(term);
}

/** A math function's value as a number (`calc(1 + 0.5)`), or null. A
 *  length in it in an absolute unit is one over another such
 *  (`calc(22px / 192px)`); a relative one has nothing here to resolve it
 *  against, and makes the value none. */
export function parseMathNumber(
  value: string,
  largest = LARGEST,
): number | null {
  const term = parseTerm(value, absoluteLength);
  if (!term || term.kind !== 'linear' || term.length || term.angle) {
    return null;
  }
  return censor(term.px, largest);
}

/**
 * A math function standing for a colour's channel (CSS Color 4, 4.1): a
 * number, a percentage or an angle, and one of them throughout —
 * `hsl(140 clamp(30%, 45%, 60%) 42%)`. A percentage here is a value of a
 * type of its own, not a share of something layout knows, so `min(30%,
 * 45%)` comes to 30% where a length's waits for what it is a share of.
 * An angle comes to degrees. Null where it is none of the three.
 */
export function parseMathChannel(
  value: string,
): { value: number; unit: '' | '%' | 'deg' } | null {
  let kind: '%' | 'deg' | null = null;
  const term = parseTerm(
    value,
    (token) => {
      const m = /^(.*?)(%|deg|grad|rad|turn)$/i.exec(token);
      if (!m) return null;
      const unit = m[2].toLowerCase();
      const of = unit === '%' ? '%' : 'deg';
      if (kind !== null && kind !== of) return null;
      kind = of;
      const n = Number(m[1]);
      return unit === 'grad'
        ? n * 0.9
        : unit === 'rad'
          ? (n * 180) / Math.PI
          : unit === 'turn'
            ? n * 360
            : n;
    },
    true,
  );
  if (!term || term.kind !== 'linear' || term.hasPct) return null;
  // an inverse trigonometric function's angle, which it gives in degrees
  if (term.angle) {
    return kind === '%' ? null : { value: censor(term.px), unit: 'deg' };
  }
  if (!term.length) return { value: censor(term.px), unit: '' };
  return kind === null ? null : { value: censor(term.px), unit: kind };
}

function parseTerm(
  value: string,
  dimension: (token: string) => number | null,
  /** Whether a percentage is a dimension `dimension` reads, as it is in a
   *  colour's channel, rather than a share of a length. */
  percentages = false,
  angular: number | null = null,
): Term | null {
  const tokens = tokenize(value);
  if (!tokens) return null;
  const parser = new Parser(tokens, dimension, percentages, angular);
  const term = parser.value();
  return term && parser.pos === tokens.length ? term : null;
}

function isLength(term: Term): boolean {
  return term.kind === 'linear' ? term.length : true;
}

function toLen(term: Term): Len | null {
  if (term.kind === 'compare') {
    const args: Len[] = [];
    for (const arg of term.args) {
      const len = toLen(arg);
      if (len === null) return null;
      args.push(len);
    }
    return { pct: 0, of: { max: term.max, args } };
  }
  if (!term.hasPct) return censor(term.px);
  return { pct: censor(term.pct), px: censor(term.px) };
}

const NUMBER = /^[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?/;

// ASCII case-insensitive, as every keyword is: `calc(NaN)` as written
const CONSTANT = /^(?:-?infinity|nan|pi|e)(?![a-z0-9_(-])/i;

/** A `round()`'s rounding strategy (CSS Values 4, 10.4.1). */
const STRATEGY = /^(?:nearest|up|down|to-zero)(?![a-z0-9_(-])/i;

/** Degrees in one of each angle unit. */
const DEGREES: Record<string, number> = {
  deg: 1,
  grad: 0.9,
  rad: 180 / Math.PI,
  turn: 360,
};

const CONSTANTS: Record<string, number> = {
  infinity: Infinity,
  '-infinity': -Infinity,
  nan: NaN,
  pi: Math.PI,
  e: Math.E,
};

/**
 * What a calculation that is no finite number comes to (CSS Values 4,
 * 10.9): NaN is 0, and an infinity the largest length there is — which,
 * as in a browser, is still a length: a radius of it is a pill.
 */
function censor(n: number, largest = LARGEST): number {
  if (Number.isNaN(n)) return 0;
  if (n === Infinity) return largest;
  if (n === -Infinity) return -largest;
  return n;
}

/** The largest length a browser holds, 2^25 pixels less a little: what a
 *  calculation's infinity comes to, and what any length is kept within
 *  (`parseLength`, `resolve`). */
export const LARGEST = 33554428;

function tokenize(text: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      while (i < text.length && /[ \t\n\r\f]/.test(text[i])) i += 1;
      if (out.length && out[out.length - 1].t !== 'space') {
        out.push({ t: 'space' });
      }
      continue;
    }
    if (c === '(') {
      out.push({ t: 'open', fn: '' });
      i += 1;
      continue;
    }
    if (c === ')' || c === ',') {
      if (out.length && out[out.length - 1].t === 'space') out.pop();
      out.push(c === ')' ? { t: 'close' } : { t: 'comma' });
      i += 1;
      continue;
    }
    if (c === '*' || c === '/') {
      out.push({ t: 'op', value: c });
      i += 1;
      continue;
    }
    // a sign belongs to the number after it, as the tokenizer reads it:
    // `1px -2px` is two values, and `1px - 2px` a difference
    const m = NUMBER.exec(text.slice(i));
    if (m) {
      i += m[0].length;
      const unit = /^(?:%|[a-z]+)/.exec(text.slice(i))?.[0] ?? '';
      i += unit.length;
      out.push({ t: 'num', value: Number(m[0]), unit });
      continue;
    }
    const name = /^-?[a-z][a-z0-9-]*\(/.exec(text.slice(i))?.[0];
    if (name) {
      out.push({ t: 'open', fn: name.slice(0, -1) });
      i += name.length;
      continue;
    }
    // the numbers CSS Values 4 names (10.7.1): Tailwind 4 writes a pill's
    // radius as `calc(infinity * 1px)`
    const strategy = STRATEGY.exec(text.slice(i))?.[0];
    if (strategy) {
      out.push({ t: 'word', value: strategy.toLowerCase() });
      i += strategy.length;
      continue;
    }
    const constant = CONSTANT.exec(text.slice(i))?.[0];
    if (constant) {
      out.push({
        t: 'num',
        value: CONSTANTS[constant.toLowerCase()],
        unit: '',
      });
      i += constant.length;
      continue;
    }
    if (c === '+' || c === '-') {
      out.push({ t: 'op', value: c });
      i += 1;
      continue;
    }
    return null;
  }
  return out;
}

class Parser {
  pos = 0;
  constructor(
    private tokens: Token[],
    private dimension: (token: string) => number | null,
    private percentages = false,
    private angular: number | null = null,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private skipSpace(): void {
    if (this.peek()?.t === 'space') this.pos += 1;
  }

  /** A whole math function, `calc(…)` and the rest. */
  value(): Term | null {
    this.skipSpace();
    const open = this.peek();
    if (open?.t !== 'open' || !open.fn) return null;
    const term = this.fn();
    this.skipSpace();
    return term;
  }

  private fn(): Term | null {
    const open = this.tokens[this.pos] as { t: 'open'; fn: string };
    this.pos += 1;
    const fn = open.fn.replace(/^-webkit-/, '').toLowerCase();
    // a `round()`'s strategy, before its first argument
    let strategy = 'nearest';
    const first = this.tokens[this.pos]?.t === 'space' ? 1 : 0;
    const word = this.tokens[this.pos + first];
    if (fn === 'round' && word?.t === 'word') {
      strategy = word.value;
      this.pos += first + 1;
      this.skipSpace();
      if (this.peek()?.t !== 'comma') return null;
      this.pos += 1;
    }
    const args: Term[] = [];
    for (;;) {
      const sum = this.sum();
      if (!sum) return null;
      args.push(sum);
      const next = this.peek();
      if (next?.t === 'comma') {
        this.pos += 1;
        continue;
      }
      if (next?.t !== 'close') return null;
      this.pos += 1;
      break;
    }
    switch (fn) {
      case '':
      case 'calc':
        return args.length === 1 ? args[0] : null;
      case 'min':
      case 'max':
        return compare(args, fn === 'max');
      case 'clamp': {
        if (args.length !== 3) return null;
        const upper = compare([args[1], args[2]], false);
        return upper && compare([args[0], upper], true);
      }
      case 'sin':
      case 'cos':
      case 'tan': {
        const rad = args.length === 1 ? this.radians(args[0]) : null;
        if (rad === null) return null;
        return number(
          fn === 'sin'
            ? Math.sin(rad)
            : fn === 'cos'
              ? Math.cos(rad)
              : tan(rad),
        );
      }
      case 'asin':
      case 'acos':
      case 'atan': {
        if (args.length !== 1 || !isNumber(args[0])) return null;
        const x = args[0].px;
        const rad =
          fn === 'asin'
            ? Math.asin(x)
            : fn === 'acos'
              ? Math.acos(x)
              : Math.atan(x);
        return this.angle((rad * 180) / Math.PI);
      }
      case 'atan2': {
        const [y, x] = args.length === 2 ? (resolved(args) ?? []) : [];
        if (!y) return null;
        return this.angle((Math.atan2(y.px, x.px) * 180) / Math.PI);
      }
      case 'pow':
      case 'sqrt':
      case 'exp':
      case 'log': {
        const arity = fn === 'pow' ? [2] : fn === 'log' ? [1, 2] : [1];
        if (!arity.includes(args.length) || !args.every(isNumber)) return null;
        const [a, b] = (args as Linear[]).map((arg) => arg.px);
        if (fn === 'pow') return number(a ** b);
        if (fn === 'sqrt') return number(Math.sqrt(a));
        if (fn === 'exp') return number(Math.exp(a));
        return number(
          args.length === 2 ? Math.log(a) / Math.log(b) : Math.log(a),
        );
      }
      case 'hypot': {
        const all = resolved(args);
        if (!all) return null;
        return like(all[0], Math.hypot(...all.map((arg) => arg.px)));
      }
      case 'abs':
      case 'sign': {
        const [a] = args.length === 1 ? (resolved(args) ?? []) : [];
        if (!a) return null;
        return fn === 'abs' ? like(a, Math.abs(a.px)) : number(Math.sign(a.px));
      }
      case 'round':
      case 'mod':
      case 'rem': {
        // the step a number is rounded to is 1 where none is given, and
        // anything else has to say its own
        const both =
          fn === 'round' && args.length === 1 && isNumber(args[0])
            ? [args[0], number(1)]
            : args;
        const [a, b] = both.length === 2 ? (resolved(both) ?? []) : [];
        if (!a) return null;
        return like(a, stepped(fn, strategy, a.px, b.px));
      }
      default:
        return null;
    }
  }

  /** What a trigonometric function takes, in radians: a number, which is
   *  one, or an angle — its own, or the caller's dimension where that is
   *  angles (`angular`). */
  private radians(term: Term): number | null {
    if (term.kind !== 'linear' || term.hasPct) return null;
    if (term.angle) return (term.px * Math.PI) / 180;
    if (!term.length) return term.px;
    if (this.angular === null) return null;
    return (term.px / this.angular) * (Math.PI / 180);
  }

  /** An angle of `deg` degrees, as the caller reads one where it does. */
  private angle(deg: number): Term {
    if (this.angular !== null)
      return linear(true, deg * this.angular, 0, false);
    return linear(false, deg, 0, false, true);
  }

  private sum(): Term | null {
    this.skipSpace();
    let left = this.product();
    if (!left) return null;
    for (;;) {
      const at = this.pos;
      // `+` and `-` need white space on both sides
      if (this.peek()?.t !== 'space') break;
      this.pos += 1;
      const op = this.peek();
      if (op?.t !== 'op' || (op.value !== '+' && op.value !== '-')) {
        this.pos = at;
        break;
      }
      this.pos += 1;
      if (this.peek()?.t !== 'space') return null;
      this.pos += 1;
      const right = this.product();
      if (!right) return null;
      left = add(left, right, op.value === '+' ? 1 : -1);
      if (!left) return null;
    }
    this.skipSpace();
    return left;
  }

  private product(): Term | null {
    let left = this.unit();
    if (!left) return null;
    for (;;) {
      const at = this.pos;
      this.skipSpace();
      const op = this.peek();
      if (op?.t !== 'op' || (op.value !== '*' && op.value !== '/')) {
        this.pos = at;
        return left;
      }
      this.pos += 1;
      this.skipSpace();
      const right = this.unit();
      if (!right) return null;
      if (op.value === '*') {
        // one side a number, which scales the other
        if (isNumber(left)) left = scale(right, left.px);
        else if (isNumber(right)) left = scale(left, right.px);
        else return null;
      } else if (isNumber(right)) {
        if (right.px === 0) return null;
        left = scale(left, 1 / right.px);
      } else {
        // a length over a length is a number (CSS Values 4, 10.9.1):
        // `scale(calc(var(--icon, 22px) / 192px))` shrinks a drawing made
        // at 192px to the size of an icon. A percentage on either side is
        // a different number at every width, and none here
        const ratio = lengthRatio(left, right);
        if (ratio === null) return null;
        left = linear(false, ratio, 0, false);
      }
    }
  }

  private unit(): Term | null {
    const token = this.peek();
    if (!token) return null;
    if (token.t === 'open') return this.fn();
    if (token.t !== 'num') return null;
    this.pos += 1;
    if (token.unit === '') return linear(false, token.value, 0, false);
    if (token.unit === '%' && !this.percentages) {
      return linear(true, 0, token.value, true);
    }
    const px = this.dimension(`${token.value}${token.unit}`);
    if (px !== null) return linear(true, px, 0, false);
    // an angle the caller does not read, which a trigonometric function
    // takes and nothing else
    const deg = DEGREES[token.unit.toLowerCase()];
    return deg === undefined
      ? null
      : linear(false, token.value * deg, 0, false, true);
  }
}

function linear(
  length: boolean,
  px: number,
  pct: number,
  hasPct: boolean,
  angle = false,
): Linear {
  return angle
    ? { kind: 'linear', length, px, pct, hasPct, angle }
    : { kind: 'linear', length, px, pct, hasPct };
}

function isNumber(term: Term): term is Linear {
  return term.kind === 'linear' && !term.length && !term.angle;
}

function number(n: number): Linear {
  return linear(false, n, 0, false);
}

/** A value of `term`'s type: a number, a length or an angle. */
function like(term: Linear, n: number): Linear {
  return linear(term.length, n, 0, false, term.angle);
}

/** Whether two terms are of one type (CSS Values 4, 10.8.1). */
function sameType(a: Term, b: Term): boolean {
  if (isLength(a) !== isLength(b)) return false;
  const angle = (t: Term) => t.kind === 'linear' && !!t.angle;
  return angle(a) === angle(b);
}

/** Arguments of one type, each worked out to a value with no percentage
 *  in it — what a function that is not linear in them takes — or null. */
function resolved(args: Term[]): Linear[] | null {
  for (const arg of args) {
    if (arg.kind !== 'linear' || arg.hasPct) return null;
    if (!sameType(arg, args[0])) return null;
  }
  return args as Linear[];
}

/** `tan()`, which is infinite at the odd multiples of 90° (CSS Values 4,
 *  10.6.1), where floating point comes a little short. */
function tan(rad: number): number {
  const quarters = rad / (Math.PI / 2);
  const nearest = Math.round(quarters);
  if (Math.abs(quarters - nearest) < 1e-12 && Math.abs(nearest % 2) === 1) {
    return ((nearest - 1) / 2) % 2 === 0 ? Infinity : -Infinity;
  }
  return Math.tan(rad);
}

/** `round()`, `mod()` and `rem()` of `a` by `b` (CSS Values 4, 10.4). */
function stepped(fn: string, strategy: string, a: number, b: number): number {
  if (b === 0) return NaN;
  if (fn === 'mod') return a - b * Math.floor(a / b);
  if (fn === 'rem') return a - b * Math.trunc(a / b);
  // the multiples of `b` and of `-b` are one set
  const step = Math.abs(b);
  if (!Number.isFinite(a)) return a;
  if (!Number.isFinite(step)) {
    // what an infinite step rounds a finite value to
    if (strategy === 'up') return a > 0 ? Infinity : a < 0 ? -0 : a;
    if (strategy === 'down') return a < 0 ? -Infinity : a > 0 ? 0 : a;
    return a < 0 || Object.is(a, -0) ? -0 : 0;
  }
  const q = a / step;
  const n =
    strategy === 'up'
      ? Math.ceil(q)
      : strategy === 'down'
        ? Math.floor(q)
        : strategy === 'to-zero'
          ? Math.trunc(q)
          : Math.floor(q + 0.5);
  return n * step;
}

/** `a / b` for two lengths of pixels alone, or two angles, or null for
 *  anything else: a percentage, a comparison, or a division by nought. */
function lengthRatio(a: Term, b: Term): number | null {
  if (a.kind !== 'linear' || b.kind !== 'linear') return null;
  if (!sameType(a, b) || (!a.length && !a.angle)) return null;
  if (a.hasPct || b.hasPct || b.px === 0) return null;
  return a.px / b.px;
}

/** CSS pixels per one of each absolute length unit: what a length is in a
 *  calculation that comes to a number (`parseMathNumber`), where a length
 *  is only ever over another, and nothing says what an em is. */
const ABSOLUTE_PX: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
};

function absoluteLength(token: string): number | null {
  const m = /^([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)([a-z]+)$/i.exec(token);
  const per = m ? ABSOLUTE_PX[m[2].toLowerCase()] : undefined;
  return per === undefined ? null : Number(m![1]) * per;
}

/** `a + b`, or `a - b` for a sign of -1, distributed into a comparison. */
function add(a: Term, b: Term, sign: 1 | -1): Term | null {
  if (!sameType(a, b)) return null;
  if (a.kind === 'compare') {
    const args: Term[] = [];
    for (const arg of a.args) {
      const sum = add(arg, b, sign);
      if (!sum) return null;
      args.push(sum);
    }
    return { kind: 'compare', max: a.max, args };
  }
  if (b.kind === 'compare') {
    // `a - min(x, y)` is `max(a - x, a - y)`
    const args: Term[] = [];
    for (const arg of b.args) {
      const sum = add(a, arg, sign);
      if (!sum) return null;
      args.push(sum);
    }
    return { kind: 'compare', max: sign === 1 ? b.max : !b.max, args };
  }
  return linear(
    a.length,
    a.px + sign * b.px,
    a.pct + sign * b.pct,
    a.hasPct || b.hasPct,
    a.angle,
  );
}

/** `term * k`, distributed into a comparison, which a negative `k` turns
 *  over. */
function scale(term: Term, k: number): Term {
  if (term.kind === 'compare') {
    return {
      kind: 'compare',
      max: k < 0 ? !term.max : term.max,
      args: term.args.map((arg) => scale(arg, k)),
    };
  }
  // nought stays nought, so that an infinity scaling a length is not also
  // a NaN of the percentage it has none of
  return linear(
    term.length,
    term.px === 0 ? 0 : term.px * k,
    term.pct === 0 ? 0 : term.pct * k,
    term.hasPct,
    term.angle,
  );
}

/** `min()` or `max()` of terms of one type: a number where no percentage
 *  is among them, and a comparison for layout where one is. */
function compare(args: Term[], max: boolean): Term | null {
  const length = isLength(args[0]);
  if (args.some((a) => !sameType(a, args[0]))) return null;
  if (args.every((a) => a.kind === 'linear' && !a.hasPct)) {
    const values = args.map((a) => (a as Linear).px);
    return linear(
      length,
      max ? Math.max(...values) : Math.min(...values),
      0,
      false,
      (args[0] as Linear).angle,
    );
  }
  return { kind: 'compare', max, args };
}
