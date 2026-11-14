// A math function as a specified value has it (CSS Values 4, 10): parsed
// into a calculation tree, type-checked (10.7), simplified as far as values
// that need no layout go (10.10), and serialized (10.12). Every math function
// is read — `calc()`, the comparisons, the stepped value functions, the
// trigonometric, exponential and sign-related ones — with the constants `e`,
// `pi`, `infinity`, `-infinity` and `NaN`. What is wrong with one, its syntax
// or its types against the property's, makes the declaration invalid, which
// `el.style` keeps nothing of; what this cannot judge — a function it does
// not know, `anchor()` or `size` — leaves the value as it was written.

/** The base types of a calculation (10.7.1). */
type Base =
  'length' | 'angle' | 'time' | 'frequency' | 'resolution' | 'flex' | 'percent';

/** A calculation's type: each base type's power. */
type MathType = Partial<Record<Base, number>>;

/** A calculation's node. */
type Node =
  | { t: 'num'; value: number; unit: string }
  | { t: 'sum'; of: Node[] }
  | { t: 'product'; of: Node[] }
  | { t: 'negate'; of: Node }
  | { t: 'invert'; of: Node }
  | { t: 'fn'; name: string; args: Node[]; strategy?: string }
  | { t: 'opaque'; text: string };

const LENGTH_UNITS = new Set(
  (
    'px cm mm q in pt pc em rem ex rex cap rcap ch rch ic ric lh rlh vw vh vi vb vmin vmax ' +
    'svw svh svi svb svmin svmax lvw lvh lvi lvb lvmin lvmax dvw dvh dvi dvb dvmin dvmax ' +
    'cqw cqh cqi cqb cqmin cqmax'
  ).split(' '),
);
const UNIT_BASE: Record<string, Base> = {
  deg: 'angle',
  grad: 'angle',
  rad: 'angle',
  turn: 'angle',
  s: 'time',
  ms: 'time',
  hz: 'frequency',
  khz: 'frequency',
  dpi: 'resolution',
  dpcm: 'resolution',
  dppx: 'resolution',
  x: 'resolution',
  fr: 'flex',
  '%': 'percent',
};

/** Each unit that converts to its base's canonical unit, and by what. */
const CANONICAL: Record<string, [string, number]> = {
  px: ['px', 1],
  in: ['px', 96],
  cm: ['px', 96 / 2.54],
  mm: ['px', 96 / 25.4],
  q: ['px', 96 / 101.6],
  pt: ['px', 96 / 72],
  pc: ['px', 16],
  deg: ['deg', 1],
  grad: ['deg', 0.9],
  rad: ['deg', 180 / Math.PI],
  turn: ['deg', 360],
  s: ['s', 1],
  ms: ['s', 0.001],
  hz: ['hz', 1],
  khz: ['hz', 1000],
  dppx: ['dppx', 1],
  x: ['dppx', 1],
  dpi: ['dppx', 1 / 96],
  dpcm: ['dppx', 2.54 / 96],
  fr: ['fr', 1],
};

const MATH_NAMES =
  /^(?:-webkit-)?(calc|min|max|clamp|round|mod|rem|sin|cos|tan|asin|acos|atan2|atan|pow|sqrt|hypot|log|exp|abs|sign)\($/i;

/** Whether a value starts with a math function. */
export const STARTS_WITH_MATH =
  /^\s*(?:-webkit-)?(?:calc|min|max|clamp|round|mod|rem|sin|cos|tan|asin|acos|atan2|atan|pow|sqrt|hypot|log|exp|abs|sign)\(/i;

/** Why a parse gave up: a syntax error, or something it cannot judge. */
class Unknown extends Error {}

class Parser {
  at = 0;
  constructor(readonly text: string) {}

  space(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at]))
      this.at += 1;
  }

  done(): boolean {
    this.space();
    return this.at === this.text.length;
  }

  /** A math function at the start, or null for bad syntax. */
  math(): Node | null {
    this.space();
    const fn = /^-?[a-z][\w-]*\(/i.exec(this.text.slice(this.at));
    if (!fn || !MATH_NAMES.test(fn[0])) return null;
    return this.value();
  }

  sum(): Node | null {
    const first = this.product();
    if (!first) return null;
    const of = [first];
    for (;;) {
      const back = this.at;
      if (!/\s/.test(this.text[this.at] ?? '')) break;
      this.space();
      const op = this.text[this.at];
      if (op !== '+' && op !== '-') {
        this.at = back;
        break;
      }
      // an operator of a sum has white space on either side
      if (!/\s/.test(this.text[this.at + 1] ?? '')) return null;
      this.at += 1;
      const next = this.product();
      if (!next) return null;
      of.push(op === '-' ? { t: 'negate', of: next } : next);
    }
    return of.length === 1 ? of[0] : { t: 'sum', of };
  }

  product(): Node | null {
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

  value(): Node | null {
    this.space();
    const rest = this.text.slice(this.at);
    const num = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:e[+-]?\d+)?(%|[a-z]+)?/i.exec(
      rest,
    );
    if (num) {
      this.at += num[0].length;
      const unit = (num[1] ?? '').toLowerCase();
      const value = Number(num[0].slice(0, num[0].length - unit.length));
      if (unit && unit !== '%' && !LENGTH_UNITS.has(unit) && !UNIT_BASE[unit]) {
        return null;
      }
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
    if (fn) {
      const math = MATH_NAMES.exec(fn[0]);
      if (!math) {
        // a function no calculation sees into
        throw new Unknown(fn[0]);
      }
      this.at += fn[0].length;
      const name = math[1].toLowerCase();
      let strategy: string | undefined;
      const args: Node[] = [];
      this.space();
      if (name === 'round') {
        const word = /^(nearest|up|down|to-zero)(?![\w-])/i.exec(
          this.text.slice(this.at),
        );
        if (word) {
          strategy = word[1].toLowerCase();
          this.at += word[0].length;
          this.space();
          if (this.text[this.at] !== ',') return null;
          this.at += 1;
        }
      }
      for (;;) {
        const arg = this.sum();
        if (!arg) return null;
        args.push(arg);
        this.space();
        const c = this.text[this.at];
        this.at += 1;
        if (c === ')') break;
        if (c !== ',') return null;
      }
      return strategy
        ? { t: 'fn', name, args, strategy }
        : { t: 'fn', name, args };
    }
    const word = /^-?[a-z][\w-]*/i.exec(rest);
    if (!word) return null;
    this.at += word[0].length;
    switch (word[0].toLowerCase()) {
      case 'pi':
        return { t: 'num', value: Math.PI, unit: '' };
      case 'e':
        return { t: 'num', value: Math.E, unit: '' };
      case 'infinity':
        return { t: 'num', value: Infinity, unit: '' };
      case '-infinity':
        return { t: 'num', value: -Infinity, unit: '' };
      case 'nan':
        return { t: 'num', value: NaN, unit: '' };
      default:
        // a keyword of a function (`size`, an `anchor()`'s side) or nothing
        throw new Unknown(word[0]);
    }
  }
}

/** How many arguments each function takes, least and most. */
const ARITY: Record<string, [number, number]> = {
  calc: [1, 1],
  min: [1, Infinity],
  max: [1, Infinity],
  clamp: [3, 3],
  round: [1, 2],
  mod: [2, 2],
  rem: [2, 2],
  sin: [1, 1],
  cos: [1, 1],
  tan: [1, 1],
  asin: [1, 1],
  acos: [1, 1],
  atan: [1, 1],
  atan2: [2, 2],
  pow: [2, 2],
  sqrt: [1, 1],
  hypot: [1, Infinity],
  log: [1, 2],
  exp: [1, 1],
  abs: [1, 1],
  sign: [1, 1],
};

const NUMBER: MathType = {};

function same(a: MathType, b: MathType): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<Base>;
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

function clean(t: MathType): MathType {
  const out: MathType = {};
  for (const [k, v] of Object.entries(t) as [Base, number][]) if (v) out[k] = v;
  return out;
}

/** Two types added (10.7.2): alike, or a percentage that stands for the
 *  other's base where the property's percentages are of it. */
function addTypes(a: MathType, b: MathType, pct: Base | null): MathType | null {
  if (same(a, b)) return a;
  if (pct) {
    const swap = (t: MathType): MathType => {
      if (!t.percent) return t;
      const out = { ...t, [pct]: (t[pct] ?? 0) + t.percent };
      delete out.percent;
      return clean(out);
    };
    if (same(swap(a), swap(b))) return swap(a);
  }
  return null;
}

/** A node's type, or null where its types do not go together. */
function typeOf(
  node: Node,
  pct: Base | null,
  noPercent = false,
): MathType | null {
  switch (node.t) {
    case 'num': {
      if (!node.unit) return NUMBER;
      // a percentage where the property has nothing it is of is no value,
      // even under a `sign()` (CSS Values 4, 10.7.4)
      if (node.unit === '%' && noPercent) return null;
      if (LENGTH_UNITS.has(node.unit)) return { length: 1 };
      return { [UNIT_BASE[node.unit]]: 1 };
    }
    case 'opaque':
      throw new Unknown(node.text);
    case 'negate':
      return typeOf(node.of, pct, noPercent);
    case 'invert': {
      const t = typeOf(node.of, pct, noPercent);
      if (!t) return null;
      const out: MathType = {};
      for (const [k, v] of Object.entries(t) as [Base, number][]) out[k] = -v;
      return out;
    }
    case 'sum': {
      let t: MathType | null = typeOf(node.of[0], pct, noPercent);
      for (const child of node.of.slice(1)) {
        const c = typeOf(child, pct, noPercent);
        if (!t || !c) return null;
        t = addTypes(t, c, pct);
      }
      return t;
    }
    case 'product': {
      const out: MathType = {};
      for (const child of node.of) {
        const c = typeOf(child, pct, noPercent);
        if (!c) return null;
        for (const [k, v] of Object.entries(c) as [Base, number][]) {
          out[k] = (out[k] ?? 0) + v;
        }
      }
      return clean(out);
    }
    case 'fn': {
      const [least, most] = ARITY[node.name];
      if (node.args.length < least || node.args.length > most) return null;
      const types = node.args.map((a) => typeOf(a, pct, noPercent));
      if (types.some((t) => !t)) return null;
      const all = types as MathType[];
      const alike = (): MathType | null => {
        let t: MathType | null = all[0];
        for (const c of all.slice(1)) t = t && addTypes(t, c, pct);
        return t;
      };
      switch (node.name) {
        case 'calc':
        case 'min':
        case 'max':
        case 'clamp':
        case 'hypot':
        case 'mod':
        case 'rem':
          return alike();
        case 'round':
          // a step left out is 1, which only a number is a step of
          if (all.length === 1 && !same(all[0], NUMBER)) return null;
          return alike();
        case 'abs':
          return all[0];
        case 'sign':
          return NUMBER;
        case 'sin':
        case 'cos':
        case 'tan':
          return same(all[0], NUMBER) || same(all[0], { angle: 1 })
            ? NUMBER
            : null;
        case 'asin':
        case 'acos':
        case 'atan':
          return same(all[0], NUMBER) ? { angle: 1 } : null;
        case 'atan2':
          return alike() ? { angle: 1 } : null;
        case 'pow':
        case 'log':
          return all.every((t) => same(t, NUMBER)) ? NUMBER : null;
        case 'sqrt':
        case 'exp':
          return same(all[0], NUMBER) ? NUMBER : null;
      }
      return null;
    }
  }
}

/** A numeric value in its base's canonical unit, where it has one. */
function canonical(node: Node): Node {
  if (node.t !== 'num' || !node.unit) return node;
  const c = CANONICAL[node.unit];
  return c ? { t: 'num', value: node.value * c[1], unit: c[0] } : node;
}

const DEG = Math.PI / 180;

/** A function of numbers of one unit worked out, or null where it cannot be. */
function evaluate(
  name: string,
  v: number[],
  unit: string,
  strategy?: string,
): { value: number; unit: string } | null {
  switch (name) {
    case 'min':
      return { value: Math.min(...v), unit };
    case 'max':
      return { value: Math.max(...v), unit };
    case 'clamp':
      return { value: Math.max(v[0], Math.min(v[1], v[2])), unit };
    case 'hypot':
      return { value: Math.hypot(...v), unit };
    case 'abs':
      return { value: Math.abs(v[0]), unit };
    case 'sign':
      return { value: Number.isNaN(v[0]) ? NaN : Math.sign(v[0]), unit: '' };
    case 'mod': {
      const [a, b] = v;
      if (b === 0 || !Number.isFinite(a)) return { value: NaN, unit };
      if (!Number.isFinite(b))
        return {
          value: Math.sign(a) === Math.sign(b) || a === 0 ? a : NaN,
          unit,
        };
      return { value: a - b * Math.floor(a / b), unit };
    }
    case 'rem': {
      const [a, b] = v;
      if (b === 0 || !Number.isFinite(a)) return { value: NaN, unit };
      if (!Number.isFinite(b)) return { value: a, unit };
      return { value: a - b * Math.trunc(a / b), unit };
    }
    case 'round': {
      const a = v[0];
      const b = v.length > 1 ? v[1] : 1;
      if (b === 0 || (!Number.isFinite(a) && !Number.isFinite(b)))
        return { value: NaN, unit };
      if (!Number.isFinite(a)) return { value: a, unit };
      if (!Number.isFinite(b)) {
        const zero = a < 0 || Object.is(a, -0) ? -0 : 0;
        if (strategy === 'up') return { value: a > 0 ? Infinity : zero, unit };
        if (strategy === 'down')
          return { value: a < 0 ? -Infinity : zero, unit };
        return { value: zero, unit };
      }
      const step = Math.abs(b);
      const lower = Math.floor(a / step) * step;
      const upper = lower + step;
      let value: number;
      switch (strategy ?? 'nearest') {
        case 'up':
          value = a === lower ? lower : upper;
          break;
        case 'down':
          value = lower;
          break;
        case 'to-zero':
          value = a < 0 ? (a === lower ? lower : upper) : lower;
          break;
        default:
          value = a - lower < upper - a ? lower : upper;
      }
      return { value, unit };
    }
    case 'sin':
    case 'cos':
    case 'tan': {
      const x = unit === 'deg' ? v[0] * DEG : v[0];
      const f =
        name === 'sin' ? Math.sin : name === 'cos' ? Math.cos : Math.tan;
      return { value: f(x), unit: '' };
    }
    case 'asin':
      return { value: Math.asin(v[0]) / DEG, unit: 'deg' };
    case 'acos':
      return { value: Math.acos(v[0]) / DEG, unit: 'deg' };
    case 'atan':
      return { value: Math.atan(v[0]) / DEG, unit: 'deg' };
    case 'atan2':
      return { value: Math.atan2(v[0], v[1]) / DEG, unit: 'deg' };
    case 'pow':
      return { value: Math.pow(v[0], v[1]), unit: '' };
    case 'sqrt':
      return { value: Math.sqrt(v[0]), unit: '' };
    case 'exp':
      return { value: Math.exp(v[0]), unit: '' };
    case 'log':
      return {
        value: v.length > 1 ? Math.log(v[0]) / Math.log(v[1]) : Math.log(v[0]),
        unit: '',
      };
  }
  return null;
}

/** CSS Values 4, 10.10, as far as values that need no layout go. */
function simplify(node: Node): Node {
  switch (node.t) {
    case 'num':
      return canonical(node);
    case 'opaque':
      return node;
    case 'negate': {
      const of = simplify(node.of);
      if (of.t === 'num') return { ...of, value: -of.value };
      if (of.t === 'negate') return of.of;
      if (of.t === 'sum')
        return simplify({
          t: 'sum',
          of: of.of.map((c) => ({ t: 'negate', of: c })),
        });
      return { t: 'negate', of };
    }
    case 'invert': {
      const of = simplify(node.of);
      if (of.t === 'num' && of.unit === '')
        return { t: 'num', value: 1 / of.value, unit: '' };
      if (of.t === 'invert') return of.of;
      return { t: 'invert', of };
    }
    case 'fn': {
      const args = node.args.map(simplify);
      if (node.name === 'calc') return args[0];
      if (args.length === 1 && (node.name === 'min' || node.name === 'max'))
        return args[0];
      if (args.every((a) => a.t === 'num')) {
        const nums = args as NumNode[];
        const unit = nums[0].unit;
        // a trigonometric function of a turn, which is the same in any unit
        const angles = ['sin', 'cos', 'tan'].includes(node.name);
        if (
          unit !== '%' &&
          nums.every((a) => a.unit === unit) &&
          (unit === '' || CANONICAL[unit] || angles)
        ) {
          const out = evaluate(
            node.name,
            nums.map((a) => a.value),
            unit,
            node.strategy,
          );
          if (out) return { t: 'num', value: out.value, unit: out.unit };
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
      const out: Node[] = [];
      for (const child of of) {
        const sameUnit =
          child.t === 'num'
            ? out.find(
                (n): n is NumNode => n.t === 'num' && n.unit === child.unit,
              )
            : undefined;
        if (sameUnit && child.t === 'num') sameUnit.value += child.value;
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
      let factor = 1;
      let numbers = 0;
      const rest: Node[] = [];
      for (const child of of) {
        if (child.t === 'num' && child.unit === '') {
          factor *= child.value;
          numbers += 1;
        } else rest.push(child);
      }
      // a value of a unit over a value of that unit, which is a number
      if (
        rest.length === 2 &&
        rest[0].t === 'num' &&
        rest[1].t === 'invert' &&
        rest[1].of.t === 'num' &&
        rest[1].of.unit === rest[0].unit
      ) {
        return {
          t: 'num',
          value: (factor * rest[0].value) / rest[1].of.value,
          unit: '',
        };
      }
      if (!rest.length) return { t: 'num', value: factor, unit: '' };
      if (rest.length === 1 && numbers) {
        const only = rest[0];
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

function sorted(of: readonly Node[]): Node[] {
  const rank = (n: Node): number =>
    n.t === 'num' ? (n.unit === '' ? 0 : n.unit === '%' ? 1 : 2) : 3;
  return of
    .map((n, i) => ({ n, i }))
    .sort((a, b) => {
      const ra = rank(a.n);
      const rb = rank(b.n);
      if (ra !== rb) return ra - rb;
      if (
        ra === 2 &&
        a.n.t === 'num' &&
        b.n.t === 'num' &&
        a.n.unit !== b.n.unit
      ) {
        return a.n.unit < b.n.unit ? -1 : 1;
      }
      return a.i - b.i;
    })
    .map(({ n }) => n);
}

/** A number to six significant figures, as C's `%g` writes it. */
function numberText(n: number): string {
  const r = Number(n.toPrecision(6));
  if (r === 0) return '0';
  const size = Math.abs(r);
  if (size < 1e6 && size >= 1e-6) return String(r);
  const [mantissa, exponent] = r.toExponential().split('e');
  return `${mantissa}e${exponent[0]}${exponent.slice(1).padStart(2, '0')}`;
}

/** A numeric value as it serializes in a calculation: an infinity or a NaN
 *  as the product that is the only way to write one (10.12). */
function numText(node: NumNode): string {
  if (Number.isFinite(node.value))
    return `${numberText(node.value)}${node.unit}`;
  const word = Number.isNaN(node.value)
    ? 'NaN'
    : node.value > 0
      ? 'infinity'
      : '-infinity';
  return node.unit ? `${word} * 1${node.unit}` : word;
}

function serialize(node: Node, root = false): string {
  switch (node.t) {
    case 'num': {
      const text = numText(node);
      return !root && !Number.isFinite(node.value) && node.unit
        ? `(${text})`
        : text;
    }
    case 'opaque':
      return node.text;
    case 'fn': {
      const args = node.args.map((a) => serialize(a, true));
      if (node.strategy && node.strategy !== 'nearest')
        args.unshift(node.strategy);
      return `${node.name}(${args.join(', ')})`;
    }
    case 'negate':
      return `(-1 * ${serialize(node.of)})`;
    case 'invert':
      return `(1 / ${serialize(node.of)})`;
    case 'sum': {
      const [first, ...rest] = sorted(node.of);
      let s = serialize(first);
      for (const child of rest) {
        if (child.t === 'negate') s += ` - ${serialize(child.of)}`;
        else if (
          child.t === 'num' &&
          child.value < 0 &&
          Number.isFinite(child.value)
        ) {
          s += ` - ${serialize({ ...child, value: -child.value })}`;
        } else s += ` + ${serialize(child)}`;
      }
      return root ? s : `(${s})`;
    }
    case 'product': {
      // a division is kept where it was written, which the cascade reads
      // left to right
      const order = node.of.some((c) => c.t === 'invert')
        ? node.of
        : sorted(node.of);
      const [first, ...rest] = order;
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

/** The root of a calculation as it serializes: a numeric value or an
 *  operation in `calc()`, a function as itself. */
function serializeRoot(node: Node): string {
  if (node.t === 'fn') return serialize(node);
  return `calc(${serialize(node, true)})`;
}

/** What a property's value is, where a math function may be all of it: the
 *  type it takes, the base its percentages are of, and whether a number
 *  stands for a percentage of nothing. */
interface Expected {
  type: MathType;
  pct: Base | null;
  /** A number is taken where `type` is not one, as `scale` takes one. */
  number?: boolean;
}

const LENGTH_PCT: Expected = { type: { length: 1 }, pct: 'length' };
const LENGTH_ONLY: Expected = { type: { length: 1 }, pct: null };
const NUMBER_ONLY: Expected = { type: NUMBER, pct: null };
const NUMBER_PCT: Expected = { type: NUMBER, pct: null, number: true };

/** The properties whose value a math function may be all of, by what it
 *  must come to. */
const EXPECTED: Record<string, Expected> = {
  opacity: NUMBER_PCT,
  'fill-opacity': NUMBER_PCT,
  'stroke-opacity': NUMBER_PCT,
  'flood-opacity': NUMBER_PCT,
  'stop-opacity': NUMBER_PCT,
  scale: NUMBER_PCT,
  'z-index': NUMBER_ONLY,
  order: NUMBER_ONLY,
  'flex-grow': NUMBER_ONLY,
  'flex-shrink': NUMBER_ONLY,
  'math-depth': NUMBER_ONLY,
  'font-weight': NUMBER_ONLY,
  orphans: NUMBER_ONLY,
  widows: NUMBER_ONLY,
  'column-count': NUMBER_ONLY,
  rotate: { type: { angle: 1 }, pct: null },
  'transition-delay': { type: { time: 1 }, pct: null },
  'transition-duration': { type: { time: 1 }, pct: null },
  'animation-delay': { type: { time: 1 }, pct: null },
  'animation-duration': { type: { time: 1 }, pct: null },
  'image-resolution': { type: { resolution: 1 }, pct: null },
  'border-top-width': LENGTH_ONLY,
  'border-right-width': LENGTH_ONLY,
  'border-bottom-width': LENGTH_ONLY,
  'border-left-width': LENGTH_ONLY,
  'outline-width': LENGTH_ONLY,
  'outline-offset': LENGTH_ONLY,
  'column-width': LENGTH_ONLY,
  perspective: LENGTH_ONLY,
  ...Object.fromEntries(
    [
      'width',
      'height',
      'min-width',
      'min-height',
      'max-width',
      'max-height',
      'inline-size',
      'block-size',
      'top',
      'right',
      'bottom',
      'left',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'flex-basis',
      'font-size',
      'text-indent',
      'letter-spacing',
      'word-spacing',
      'row-gap',
      'column-gap',
    ].map((p) => [p, LENGTH_PCT]),
  ),
};

/**
 * A property's value that is one math function, as `el.style` keeps it:
 * simplified and serialized; null where it is invalid, its syntax or its
 * types; undefined where this cannot say — no math function all of it, a
 * function in it this does not know, or a property whose type it does not
 * know and nothing else wrong with it.
 */
export function specifiedMath(
  prop: string,
  value: string,
): string | null | undefined {
  if (!STARTS_WITH_MATH.test(value)) return undefined;
  const text = value.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  const parser = new Parser(text);
  let node: Node | null;
  try {
    node = parser.math();
    // a value of more than the one function is the property's to read
    if (node && !parser.done()) return undefined;
  } catch (e) {
    if (e instanceof Unknown) return undefined;
    throw e;
  }
  if (!node) return null;
  const expected = EXPECTED[prop.toLowerCase()];
  let type: MathType | null;
  try {
    type = typeOf(
      node,
      expected ? expected.pct : 'length',
      !!expected && !expected.pct && !expected.number,
    );
  } catch (e) {
    if (e instanceof Unknown) return undefined;
    throw e;
  }
  if (!type) return null;
  if (!expected) return undefined;
  // a percentage, alone or added to its base, is of the property's base
  let pctType = type;
  if (expected.pct && type.percent) {
    pctType = {
      ...type,
      [expected.pct]: (type[expected.pct] ?? 0) + type.percent,
    };
    delete pctType.percent;
    pctType = clean(pctType);
  }
  const fits =
    same(pctType, expected.type) ||
    (expected.number && (same(type, NUMBER) || same(type, { percent: 1 })));
  if (!fits) return null;
  // a function no comparison is, unresolved, keeps the `calc()` around it
  const simplified = simplify(node);
  if (
    simplified.t === 'fn' &&
    node.t === 'fn' &&
    node.name === 'calc' &&
    !['min', 'max', 'clamp'].includes(simplified.name)
  ) {
    return `calc(${serialize(simplified)})`;
  }
  return serializeRoot(simplified);
}
