// `calc()`, `min()`, `max()` and `clamp()` (CSS Values 4 10), read down to
// what a length here can hold: device pixels, or a percentage of what
// layout knows with pixels added (`Pct.px`) — every `calc()` that adds and
// scales, which is what documents write: `calc(100% - 2em)`. A comparison
// with a percentage in it, `min(100%, 600px)`, is a different sum at every
// width, and is kept as one (`Pct.of`) for layout to resolve; sums and
// scales distribute into it, so `calc(min(100%, 600px) - 2rem)` is
// `min(100% - 2rem, 600px - 2rem)`.

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
  | { t: 'space' };

/**
 * A math function's value as a length, or null where it is none — a
 * number, a type that does not add up, a division by zero. `dimension`
 * reads one `10px` or `2em` as this package's lengths do.
 */
export function parseMath(
  value: string,
  dimension: (token: string) => number | null,
): Len | null {
  const term = parseTerm(value, dimension);
  if (!term || !isLength(term)) return null;
  return toLen(term);
}

/** A math function's value as a number (`calc(1 + 0.5)`), or null. */
export function parseMathNumber(value: string): number | null {
  const term = parseTerm(value, () => null);
  if (!term || term.kind !== 'linear' || term.length) return null;
  return censor(term.px);
}

function parseTerm(
  value: string,
  dimension: (token: string) => number | null,
): Term | null {
  const tokens = tokenize(value);
  if (!tokens) return null;
  const parser = new Parser(tokens, dimension);
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

const CONSTANT = /^(?:-?infinity|nan|pi|e)(?![a-z0-9_(-])/;

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
function censor(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n === Infinity) return LARGEST;
  if (n === -Infinity) return -LARGEST;
  return n;
}

/** The largest length a browser holds, 2^25 pixels less a little. */
const LARGEST = 33554428;

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
    const constant = CONSTANT.exec(text.slice(i))?.[0];
    if (constant) {
      out.push({ t: 'num', value: CONSTANTS[constant], unit: '' });
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
    const fn = open.fn.replace(/^-webkit-/, '');
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
      default:
        return null;
    }
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
      } else {
        if (!isNumber(right) || right.px === 0) return null;
        left = scale(left, 1 / right.px);
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
    if (token.unit === '%') return linear(true, 0, token.value, true);
    const px = this.dimension(`${token.value}${token.unit}`);
    return px === null ? null : linear(true, px, 0, false);
  }
}

function linear(
  length: boolean,
  px: number,
  pct: number,
  hasPct: boolean,
): Linear {
  return { kind: 'linear', length, px, pct, hasPct };
}

function isNumber(term: Term): term is Linear {
  return term.kind === 'linear' && !term.length;
}

/** `a + b`, or `a - b` for a sign of -1, distributed into a comparison. */
function add(a: Term, b: Term, sign: 1 | -1): Term | null {
  if (isLength(a) !== isLength(b)) return null;
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
  );
}

/** `min()` or `max()` of terms of one type: a number where no percentage
 *  is among them, and a comparison for layout where one is. */
function compare(args: Term[], max: boolean): Term | null {
  const length = isLength(args[0]);
  if (args.some((a) => isLength(a) !== length)) return null;
  if (args.every((a) => a.kind === 'linear' && !a.hasPct)) {
    const values = args.map((a) => (a as Linear).px);
    return linear(
      length,
      max ? Math.max(...values) : Math.min(...values),
      0,
      false,
    );
  }
  return { kind: 'compare', max, args };
}
