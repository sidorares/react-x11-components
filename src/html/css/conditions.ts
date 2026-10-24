// The conditions `if()` and `@container` ask (CSS Values 5, 7.3; CSS
// Conditional 5, 3): `not`, `and` and `or` over tests in brackets, the
// grammar `@media` and `@supports` have too — and `style()`, which both
// ask of custom properties.
//
// A condition is answered in three values (Media Queries 4, 3.2): a test
// nothing here knows is unknown rather than false, so that `not` of it is
// unknown too, and an unknown condition holds nowhere.

import { parseMath, parseMathNumber } from './calc.js';

/** True, false, or unknown: a test nothing here can answer. */
export type Kleene = boolean | undefined;

/** A test in a condition: `( … )` with no condition in it, or a
 *  function's, `style( … )`, its name lowercased. */
export type Leaf = (name: string, inner: string) => Kleene;

/**
 * Whether a condition holds: true, false, unknown, or null where it is
 * none — `and` and `or` mixed at one level, a bracket left open, a word
 * where a test should be. `leaf` answers each test; a bracket whose
 * contents are themselves a condition is read as one, so `((a) or (b))`
 * reaches `leaf` as `a` and `b`.
 */
export function evaluateCondition(text: string, leaf: Leaf): Kleene | null {
  const items = itemsOf(text);
  if (!items || !items.length) return null;
  if (items[0].word === 'not') {
    if (items.length !== 2 || items[1].word !== null) return null;
    const one = answer(items[1], leaf);
    return one === null ? null : one === undefined ? undefined : !one;
  }
  // `a and b and c`, or `a or b or c`, never the two together
  let op: string | null = null;
  const answers: Kleene[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (i % 2 === 1) {
      if (item.word !== 'and' && item.word !== 'or') return null;
      if (op !== null && op !== item.word) return null;
      op = item.word;
      continue;
    }
    if (item.word !== null) return null;
    const one = answer(item, leaf);
    if (one === null) return null;
    answers.push(one);
  }
  if (items.length % 2 === 0) return null;
  if (op === 'or') {
    if (answers.includes(true)) return true;
    return answers.includes(undefined) ? undefined : false;
  }
  if (answers.includes(false)) return false;
  return answers.includes(undefined) ? undefined : true;
}

interface Item {
  /** A keyword between tests, lowercased: `not`, `and`, `or`. Null for a
   *  test. */
  word: string | null;
  /** A function's name, lowercased, or '' for a bracket. */
  name: string;
  inner: string;
}

/** A test's answer: a bracket holding a condition is that condition's. */
function answer(item: Item, leaf: Leaf): Kleene | null {
  if (item.name === '' && isCondition(item.inner)) {
    const nested = evaluateCondition(item.inner, leaf);
    // `(width > calc(1px))` starts like no condition, but `((a) b)` is
    // none of anything: only a bracket that is no condition is a test
    if (nested !== null) return nested;
  }
  return leaf(item.name, item.inner.trim());
}

/** Whether a bracket's contents start as a condition does rather than as
 *  a test: a bracket of their own, `not`, or a function. */
function isCondition(inner: string): boolean {
  const text = inner.trimStart();
  return (
    text.startsWith('(') ||
    /^not\s/i.test(text) ||
    /^-?[a-z_][\w-]*\(/i.test(text)
  );
}

/** A condition's tests and keywords at its top level, or null where a
 *  bracket does not close or something stands that is neither. */
function itemsOf(text: string): Item[] | null {
  const out: Item[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const word = /^-?[a-z_][\w-]*/i.exec(text.slice(i))?.[0];
    if (c === '(' || (word && text[i + word.length] === '(')) {
      const open = c === '(' ? i : i + word!.length;
      const close = closeOf(text, open);
      if (close < 0) return null;
      out.push({
        word: null,
        name: c === '(' ? '' : word!.toLowerCase(),
        inner: text.slice(open + 1, close),
      });
      i = close + 1;
      continue;
    }
    if (!word) return null;
    out.push({ word: word.toLowerCase(), name: '', inner: '' });
    i += word.length;
  }
  return out;
}

/** The `)` closing the bracket opened at `open`, strings passed over. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return c === ')' ? i : -1;
    }
  }
  return -1;
}

/**
 * Whether a style query holds (CSS Conditional 5, 3.3) — what `style( … )`
 * holds, in an `if()` and in a `@container` — over `get`, the custom
 * properties of the element it asks: one feature, `--name: value` or
 * `--name`, or a condition of them in brackets. `value` substitutes the
 * `var()`s in what a feature compares with.
 *
 * A custom property that is not registered compares as it was written, so
 * `1` is not `1.0` and `a  b` is not `a b`, white space at either end
 * aside; `initial` is a property nothing set, and `inherit` the value of
 * whatever the element inherits from (`inherited`). A feature of a
 * property that is not a custom one, which no engine answers yet, is
 * unknown. A range, `--n > 2`, compares numbers or dimensions of one unit.
 */
export function styleQuery(
  inner: string,
  get: (name: string) => string | undefined,
  value: (text: string) => string | null = (text) => text,
  /** A length a range compares, in the pixels of whoever asks — relative
   *  ones against its font — or null for none; absent, only `px`. */
  length: (text: string) => number | null = pxOnly,
  /** The syntax, the initial value and the inheritance a property was
   *  registered with (`@property`), or null for one that was not. */
  registered: (name: string) => Registered | null = () => null,
  /** A colour as whoever asks computes it — its `light-dark()` in its
   *  colour scheme — or null for none. */
  color: (text: string) => string | null = () => null,
  /** A custom property's value on what whoever asks inherits from — its
   *  parent — which `inherit` compares with, and `unset` for a property
   *  that inherits (CSS Conditional 5, 3.3: the value is computed for the
   *  element asked). Absent, `inherit` is no value it has. */
  inherited?: (name: string) => string | undefined,
): Kleene {
  const text = inner.trim();
  // a feature of what is no custom property makes the whole query none,
  // not one term of it unknown: `style((--a: b) or (unknown))` holds
  // nowhere, as no engine answers a standard property yet
  let invalid = false;
  // and what is no feature at all — a stray `;` or `!`, a function where a
  // name should be, a range that points both ways — is a test nothing
  // answers, which the query is (`<general-enclosed>`)
  let malformed = false;
  const feature = (f: string): Kleene => {
    const answer = styleFeature(
      f,
      get,
      value,
      length,
      registered,
      color,
      inherited,
    );
    if (answer === MALFORMED) {
      malformed = true;
      return undefined;
    }
    if (answer === undefined) invalid = true;
    return answer;
  };
  if (text.startsWith('(') || /^not\s/i.test(text)) {
    const answer = evaluateCondition(text, (name, test) => {
      if (name !== '') invalid = true;
      return name === '' ? feature(test) : undefined;
    });
    if (malformed) return undefined;
    return answer === null || invalid ? false : answer;
  }
  const answer = feature(text);
  if (malformed) return undefined;
  return invalid ? false : answer;
}

/** A style feature that is none: not a declaration, not a range. */
const MALFORMED = 'malformed';

/** Whether text holds `;` or `!` outside brackets, which no value of a
 *  declaration a query asks about may. */
function strayToken(text: string): boolean {
  let depth = 0;
  for (const c of text) {
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && (c === ';' || c === '!')) return true;
  }
  return false;
}

/** What a style query reads of a property's registration. */
export interface Registered {
  syntax?: string;
  initial: string | null;
  /** Whether it inherits; absent, it does, as a custom property does. */
  inherits?: boolean;
}

function styleFeature(
  text: string,
  get: (name: string) => string | undefined,
  value: (text: string) => string | null,
  length: (text: string) => number | null,
  registered: (name: string) => Registered | null,
  color: (text: string) => string | null,
  inherited: ((name: string) => string | undefined) | undefined,
): Kleene | typeof MALFORMED {
  const colon = /^(--[\w\u0080-￿-]+|[a-z-]+)\s*(?::([\s\S]*))?$/i.exec(text);
  if (colon) {
    const name = colon[1];
    if (!name.startsWith('--')) return undefined;
    const has = get(name);
    if (colon[2] === undefined) return has !== undefined;
    // a query's `!important` is a declaration's, and asks nothing more
    const asked = colon[2].replace(/!\s*important\s*$/i, '');
    if (strayToken(asked)) return MALFORMED;
    // a keyword that rolls the cascade back is no value to have
    if (/^\s*revert(?:-layer|-rule)?\s*$/i.test(asked)) return false;
    let want = value(asked);
    // a `var()` that comes to nothing is the guaranteed-invalid value,
    // which a property nothing set has as well
    if (want === null) return has === undefined;
    const reg = registered(name);
    const keyword = /^\s*(initial|inherit|unset)\s*$/i
      .exec(want)?.[1]
      .toLowerCase();
    // `unset` is `inherit` for a property that inherits, as a custom one
    // does unless it is registered not to, and `initial` for one that
    // does not
    const kind =
      keyword === 'unset'
        ? reg?.inherits === false
          ? 'initial'
          : 'inherit'
        : keyword;
    if (kind === 'inherit' && inherited) {
      // the value it would have taken from its parent: what nothing set
      // is the guaranteed-invalid value, which only that matches
      const from = inherited(name);
      if (from === undefined || has === undefined) return from === has;
      want = from;
    } else {
      // `initial` is a registered property's initial value, and an
      // unregistered one's is nothing
      if (reg?.initial != null && kind === 'initial') want = reg.initial;
      // a property nothing set is at its initial value, which `unset` is
      // as well, a custom property's being its parent's
      if (has === undefined) return kind === 'initial' || keyword === 'unset';
    }
    // a registered length is compared as one, whatever unit either says
    if (reg?.syntax && /^\s*<length(?:-percentage)?>\s*$/.test(reg.syntax)) {
      const a = length(has);
      const b = length(want);
      if (a !== null && b !== null) return Math.abs(a - b) < 1e-6;
    }
    // and a registered colour as one
    if (reg?.syntax && /^\s*<color>\s*$/.test(reg.syntax)) {
      const a = color(has);
      const b = color(want);
      if (a !== null && b !== null) return a === b;
    }
    return has.trim() === want.trim();
  }
  return styleRange(text, get, value, length);
}

/** A range's sides and its comparisons, split where neither is in a
 *  bracket: `attr(x type(<length>))` is one side. */
function splitRange(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && (c === '<' || c === '>' || c === '=')) {
      const op = text[i + 1] === '=' && c !== '=' ? `${c}=` : c;
      out.push(text.slice(start, i).trim(), op);
      i += op.length - 1;
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** A length in `px` alone, where whoever asks reads none of its own. */
function pxOnly(text: string): number | null {
  const m = /^([+-]?(?:\d*\.\d+|\d+\.?)(?:e[+-]?\d+)?)px$/i.exec(text.trim());
  return m ? Number(m[1]) : null;
}

/** One side of a range: a number, or a dimension in its type's canonical
 *  unit — a length in pixels, an angle in degrees, a time in
 *  milliseconds, a resolution in dots per pixel. */
interface Typed {
  type: 'number' | 'percentage' | 'length' | 'angle' | 'time' | 'resolution';
  n: number;
}

const UNITS: Record<string, ['angle' | 'time' | 'resolution', number]> = {
  deg: ['angle', 1],
  grad: ['angle', 0.9],
  rad: ['angle', 180 / Math.PI],
  turn: ['angle', 360],
  s: ['time', 1000],
  ms: ['time', 1],
  dppx: ['resolution', 1],
  x: ['resolution', 1],
  dpi: ['resolution', 1 / 96],
  dpcm: ['resolution', 2.54 / 96],
};

const DIMENSION = /^([+-]?(?:\d*\.\d+|\d+\.?)(?:e[+-]?\d+)?)([a-z%]*)$/i;

/** What a side of a range is (CSS Conditional 5, 3.3), its math worked
 *  out; null for none of the types a range compares. */
function typedOf(
  text: string,
  length: (text: string) => number | null,
): Typed | null {
  const t = text.trim();
  const m = DIMENSION.exec(t);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (!unit) return { type: 'number', n };
    if (unit === '%') return { type: 'percentage', n };
    const of = UNITS[unit];
    if (of) return { type: of[0], n: n * of[1] };
  } else if (t.includes('(')) {
    const number = parseMathNumber(t);
    if (number !== null) return { type: 'number', n: number };
    for (const type of ['angle', 'time', 'resolution'] as const) {
      const sum = parseMath(t, (token) => {
        const d = DIMENSION.exec(token);
        const of = d && UNITS[d[2].toLowerCase()];
        return of && of[0] === type ? Number(d[1]) * of[1] : null;
      });
      if (typeof sum === 'number') return { type, n: sum };
    }
  }
  const px = length(t);
  return px === null ? null : { type: 'length', n: px };
}

/** `env()`'s value where a range compares one: a safe area's inset is
 *  none on a screen with no notch, and any other is its fallback. */
function substituteEnv(text: string): string {
  return text.replace(
    /env\(\s*([\w-]+)\s*(?:,\s*([^)]*))?\)/gi,
    (all, name: string, fallback?: string) =>
      /^safe-area-(?:max-)?inset-/i.test(name) ? '0px' : (fallback ?? all),
  );
}

/**
 * `--n > 2`, `1 < --n <= 4`, `1px <= 1em`: each side a custom property's
 * value or a value of its own, its `var()`s, `attr()`s and `env()`s
 * substituted and its math worked out, and all of one type, in which a
 * zero with no unit is a length (CSS Conditional 5, 3.3).
 */
function styleRange(
  text: string,
  get: (name: string) => string | undefined,
  value: (text: string) => string | null,
  length: (text: string) => number | null,
): Kleene | typeof MALFORMED {
  const parts = splitRange(text);
  if (parts.length !== 3 && parts.length !== 5) return MALFORMED;
  // a side of nothing, or with a stray token; and a range of two
  // comparisons points one way, `<` or `>`, as a media query's does
  if (parts.some((part, i) => i % 2 === 0 && (!part || strayToken(part)))) {
    return MALFORMED;
  }
  if (parts.length === 5) {
    const [a, b] = [parts[1][0], parts[3][0]];
    if (a === '=' || b === '=' || a !== b) return MALFORMED;
  }
  const operand = (part: string): Typed | null => {
    const read = /^--[\w\u0080-\uffff-]+$/.test(part) ? get(part) : value(part);
    if (read === undefined || read === null) return null;
    return typedOf(substituteEnv(read), length);
  };
  const values: Typed[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const v = operand(parts[i]);
    if (!v) return false;
    values.push(v);
  }
  // a zero with no unit is a length beside one, and nothing else's
  const lengths = values.some((v) => v.type === 'length');
  const types = new Set(
    values
      .filter((v) => !(lengths && v.type === 'number' && v.n === 0))
      .map((v) => v.type),
  );
  if (types.size > 1) return false;
  for (let i = 1; i < parts.length; i += 2) {
    if (!compare(values[(i - 1) / 2].n, parts[i], values[(i + 1) / 2].n)) {
      return false;
    }
  }
  return true;
}

/** `a op b`, for one of the five comparisons a range has. */
export function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    default:
      return a === b;
  }
}
