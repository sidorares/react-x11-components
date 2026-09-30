// Custom properties and `var()` (CSS Custom Properties 1). A `--name`
// declaration is kept as written, per element and inherited; a `var()` in
// any other declaration is replaced by it before the declaration is read,
// so a shorthand, a `calc()` or a colour function sees the value it names.
//
// A document with none of either pays nothing: the cascade asks only when
// some declaration has one (`Declaration.custom`, `Declaration.vars`).

/**
 * An element's custom properties: its own over those it inherits, with
 * every `var()` in them already replaced. A chain rather than a copy: an
 * element that sets two properties over a theme of three hundred holds
 * two, where a copy made every such element pay for the theme.
 */
export class CustomProps {
  /** Its own, where `null` is none over an inherited one (`initial`). */
  readonly own: Map<string, string | null>;
  readonly parent: CustomProps | null;
  private readonly depth: number;

  constructor(parent: CustomProps | null) {
    // a lookup walks the chain, so a long one is folded into one map
    if (parent && parent.depth >= FOLD_DEPTH) parent = parent.folded();
    this.own = new Map();
    this.parent = parent;
    this.depth = parent ? parent.depth + 1 : 0;
  }

  get(name: string): string | undefined {
    for (let at: CustomProps | null = this; at; at = at.parent) {
      const value = at.own.get(name);
      if (value !== undefined) return value ?? undefined;
    }
    return undefined;
  }

  /** The whole chain as one link, with the same answers. */
  private folded(): CustomProps {
    const out = new CustomProps(null);
    const links: CustomProps[] = [];
    for (let at: CustomProps | null = this; at; at = at.parent) links.push(at);
    for (let i = links.length - 1; i >= 0; i -= 1) {
      for (const [name, value] of links[i].own) {
        if (value === null) out.own.delete(name);
        else out.own.set(name, value);
      }
    }
    return out;
  }
}

const FOLD_DEPTH = 16;

/**
 * The custom properties an element has: `own`, its declarations in cascade
 * order, over `parent`'s. A `var()` in one of its own is resolved against
 * the rest, and one that names a property in a cycle with it, or none with
 * no fallback, leaves it no value at all (CSS Custom Properties 1 2.3, 3).
 */
export function customProperties(
  own: ReadonlyMap<string, string>,
  parent: CustomProps | null,
): CustomProps {
  const out = new CustomProps(parent);
  for (const [name, value] of own) {
    const keyword = value.trim().toLowerCase();
    if (keyword === 'initial') {
      out.own.set(name, null);
    } else if (
      keyword === 'inherit' ||
      keyword === 'unset' ||
      keyword === 'revert' ||
      keyword === 'revert-layer'
    ) {
      // a custom property inherits, so each of these is its parent's
      out.own.set(name, parent?.get(name) ?? null);
    } else {
      out.own.set(name, value);
    }
  }
  const state = new Map<string, boolean>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  const visit = (name: string): string | undefined => {
    // an inherited one was resolved where it was declared
    if (!own.has(name)) return parent?.get(name);
    const done = state.get(name);
    if (done === false) {
      // on the stack: a cycle, and nothing in it has a value, whatever
      // its fallbacks say
      for (let i = stack.lastIndexOf(name); i < stack.length; i += 1) {
        cyclic.add(stack[i]);
      }
      return undefined;
    }
    if (done === true) return out.own.get(name) ?? undefined;
    state.set(name, false);
    stack.push(name);
    const raw = out.own.get(name);
    if (raw && hasVar(raw)) {
      const value = substitute(raw, visit);
      out.own.set(name, value === null || cyclic.has(name) ? null : value);
    }
    stack.pop();
    state.set(name, true);
    return out.own.get(name) ?? undefined;
  };
  for (const name of own.keys()) visit(name);
  return out;
}

/**
 * `substitute`, remembered for the properties it was asked against: the
 * elements under one that sets custom properties share its `CustomProps`,
 * so a `var()` a utility class writes is replaced once for all of them.
 * What is remembered goes with the properties. With none, there is nothing
 * to key it on that would go, and only fallbacks to read.
 */
export function substituteIn(
  value: string,
  props: CustomProps | null,
): string | null {
  if (!props) return substitute(value, null);
  let memo = SUBSTITUTED.get(props);
  if (!memo) {
    memo = new Map();
    SUBSTITUTED.set(props, memo);
  }
  const hit = memo.get(value);
  if (hit !== undefined) return hit;
  const out = substitute(value, props);
  memo.set(value, out);
  return out;
}

const SUBSTITUTED = new WeakMap<CustomProps, Map<string, string | null>>();

/** Whether a value has a `var()` in it. */
export function hasVar(value: string): boolean {
  return VAR.test(value);
}

/**
 * Whether each `var()` in a value is one: closed, naming a custom property,
 * and with a fallback, if it has one, that could be a declaration's value —
 * no `;` or `!` outside its brackets, no string a newline cuts off. One that
 * is not makes its declaration invalid as it is parsed, not as it is used,
 * so the declaration before it stands (CSS Custom Properties 1 3).
 */
export function validVars(value: string): boolean {
  let i = 0;
  for (;;) {
    const at = findVar(value, i);
    if (at < 0) return true;
    const open = at + 4;
    const close = closingParen(value, open);
    if (close < 0) return false;
    const inner = value.slice(open, close);
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    if (!NAME.test(name)) return false;
    if (comma >= 0) {
      const fallback = inner.slice(comma + 1);
      if (topLevel(fallback, ';') >= 0 || topLevel(fallback, '!') >= 0) {
        return false;
      }
      if (hasVar(fallback) && !validVars(fallback)) return false;
    }
    i = close + 1;
  }
}

/** A name a `var()` may give: two dashes, and name characters. `--` alone
 *  names nothing a declaration can set, and so falls back. */
const NAME =
  /^--(?:[\w-]|[^\x00-\x7f]|\\[0-9a-f]{1,6}[ \t\n\r\f]?|\\[^0-9a-f\n\r\f])*$/i;

/** A name with its escapes read: `--\30 ` is `--0`. */
function unescapeName(name: string): string {
  if (!name.includes('\\')) return name;
  return name.replace(
    /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([\s\S]))/gi,
    (_, hex: string | undefined, ch: string | undefined) => {
      if (!hex) return ch ?? '';
      // nothing, a surrogate or past Unicode is the replacement character,
      // as CSS reads it, where `fromCodePoint` would throw
      const code = parseInt(hex, 16);
      const valid =
        code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return String.fromCodePoint(valid ? code : 0xfffd);
    },
  );
}

const VAR = /(?:^|[^\w-])var\(/i;

/**
 * `value` with each `var()` in it replaced by the custom property it names,
 * or by its fallback where there is none — or null where there is neither,
 * which makes the declaration invalid at computed-value time. A value is
 * put in with a space either side, so what the tokenizer would not join
 * is not joined: `var(--size)px` is no length.
 */
export function substitute(
  value: string,
  lookup: CustomProps | ((name: string) => string | undefined) | null,
): string | null {
  const get =
    typeof lookup === 'function' ? lookup : (name: string) => lookup?.get(name);
  let out = '';
  let i = 0;
  for (;;) {
    const at = findVar(value, i);
    if (at < 0) break;
    const open = at + 4;
    const close = closingParen(value, open);
    if (close < 0) return null;
    const inner = value.slice(open, close);
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    if (!NAME.test(name)) return null;
    let replacement = get(unescapeName(name));
    if (replacement === undefined) {
      if (comma < 0) return null;
      const fallback = inner.slice(comma + 1);
      const resolved = hasVar(fallback) ? substitute(fallback, get) : fallback;
      if (resolved === null) return null;
      replacement = resolved;
    }
    out += `${value.slice(i, at)} ${replacement.trim()} `;
    i = close + 1;
  }
  return (out + value.slice(i)).trim();
}

/** Where the next `var(` that is a function of its own starts, from `from`. */
function findVar(value: string, from: number): number {
  const lower = value.toLowerCase();
  let at = lower.indexOf('var(', from);
  while (at > 0 && /[\w-]/.test(value[at - 1])) {
    at = lower.indexOf('var(', at + 4);
  }
  return at;
}

/** The `)` that closes a bracket opened just before `from`, strings and
 *  brackets inside it passed over; -1 where none does. */
export function closingParen(value: string, from: number): number {
  let depth = 0;
  for (let i = from; i < value.length; i += 1) {
    const c = value[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      const end = stringEnd(value, i);
      if (end < 0) return -1;
      i = end;
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return c === ')' ? i : -1;
      depth -= 1;
    }
  }
  // the end of a style sheet closes what it leaves open (CSS Syntax 3 5.4)
  return value.length;
}

/** Where a string opened at `at` closes: its quote, or the end, which
 *  closes it too — or -1 where a newline cuts it off, a bad string. */
function stringEnd(value: string, at: number): number {
  const quote = value[at];
  for (let i = at + 1; i < value.length; i += 1) {
    const c = value[i];
    if (c === '\\') i += 1;
    else if (c === quote) return i;
    else if (c === '\n' || c === '\r' || c === '\f') return -1;
  }
  return value.length;
}

/** Whether a bracket closes that nothing opened, which no value holds. */
export function unbalanced(value: string): boolean {
  const open: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      const end = stringEnd(value, i);
      if (end < 0) return true;
      i = end;
    } else if (c === '(' || c === '[' || c === '{') {
      open.push(c === '(' ? ')' : c === '[' ? ']' : '}');
    } else if (c === ')' || c === ']' || c === '}') {
      if (open.pop() !== c) return true;
    }
  }
  return false;
}

/** The first `ch` outside brackets and strings, or -1. */
function topLevel(value: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      const end = stringEnd(value, i);
      if (end < 0) return -1;
      i = end;
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
    } else if (c === ch && depth === 0) {
      // `<!--` is a token of its own, and no `!`
      if (ch === '!' && value[i - 1] === '<' && value.startsWith('--', i + 1)) {
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** The first comma not inside a bracket or a string, or -1. */
export function topLevelComma(value: string): number {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      const end = value.indexOf(c, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      return i;
    }
  }
  return -1;
}
