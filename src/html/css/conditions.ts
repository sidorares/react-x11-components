// The conditions `if()` and `@container` ask (CSS Values 5, 7.3; CSS
// Conditional 5, 3): `not`, `and` and `or` over tests in brackets, the
// grammar `@media` and `@supports` have too — and `style()`, which both
// ask of custom properties.
//
// A condition is answered in three values (Media Queries 4, 3.2): a test
// nothing here knows is unknown rather than false, so that `not` of it is
// unknown too, and an unknown condition holds nowhere.

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
 * aside; `initial` is a property nothing set. A feature of a property that
 * is not a custom one, which no engine answers yet, is unknown. A range,
 * `--n > 2`, compares numbers or dimensions of one unit.
 */
export function styleQuery(
  inner: string,
  get: (name: string) => string | undefined,
  value: (text: string) => string | null = (text) => text,
): Kleene {
  const text = inner.trim();
  const feature = (f: string): Kleene => styleFeature(f, get, value);
  if (text.startsWith('(') || /^not\s/i.test(text)) {
    const answer = evaluateCondition(text, (name, test) =>
      name === '' ? feature(test) : undefined,
    );
    return answer === null ? false : answer;
  }
  return feature(text);
}

function styleFeature(
  text: string,
  get: (name: string) => string | undefined,
  value: (text: string) => string | null,
): Kleene {
  const colon = /^(--[\w\u0080-￿-]+|[a-z-]+)\s*(?::([\s\S]*))?$/i.exec(text);
  if (colon) {
    const name = colon[1];
    if (!name.startsWith('--')) return undefined;
    const has = get(name);
    if (colon[2] === undefined) return has !== undefined;
    const want = value(colon[2]);
    if (want === null) return false;
    if (has === undefined) return /^\s*initial\s*$/i.test(want);
    return has.trim() === want.trim();
  }
  return styleRange(text, get, value);
}

const RANGE = /(<=|>=|<|>|=)/;

/** `--n > 2`, `1 < --n <= 4`: numbers or dimensions of one unit. */
function styleRange(
  text: string,
  get: (name: string) => string | undefined,
  value: (text: string) => string | null,
): Kleene {
  const parts = text.split(RANGE).map((part) => part.trim());
  if (parts.length !== 3 && parts.length !== 5) return undefined;
  const operand = (part: string): [number, string] | null => {
    const read = part.startsWith('--') ? get(part) : value(part);
    if (read === undefined || read === null) return null;
    const m = /^([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i.exec(
      read.trim(),
    );
    return m ? [Number(m[1]), m[2].toLowerCase()] : null;
  };
  const values: [number, string][] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const v = operand(parts[i]);
    if (!v) return false;
    values.push(v);
  }
  if (values.some(([, unit]) => unit !== values[0][1])) return false;
  for (let i = 1; i < parts.length; i += 2) {
    if (!compare(values[(i - 1) / 2][0], parts[i], values[(i + 1) / 2][0])) {
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
