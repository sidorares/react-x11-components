// Custom properties and `var()` (CSS Custom Properties 1). A `--name`
// declaration is kept as written, per element and inherited; a `var()` in
// any other declaration is replaced by it before the declaration is read,
// so a shorthand, a `calc()` or a colour function sees the value it names.
//
// `if()` (CSS Values 5, 7.3) is replaced the same way and at the same time:
// it is a substitution function as `var()` is, its branches chosen by what
// the element's custom properties are, `style()`, and by `media()` and
// `supports()`. So a declaration with one waits, unread, for the element's
// custom properties, as one with a `var()` does.
//
// A custom function's call (CSS Mixins 1, 2), `--name(…)`, is the third:
// the `@function` it names is evaluated with its arguments where the call
// is replaced, and what its `result` comes to stands for the call. And
// `inherit()` (CSS Values 5, 7.6) is the fourth: the value the parent has,
// of a custom property or of a property, or of the one declared.
//
// A document with none of these pays nothing: the cascade asks only when
// some declaration has one (`Declaration.custom`, `Declaration.vars`).
//
// What an `attr()` substitutes is attr()-tainted (CSS Values 5, 8.7.2), and
// so is the whole of whatever a substitution made with a tainted value in
// it: a custom property, a `var()`, an `if()` whose condition read one. A
// tainted value as or in a URL makes its declaration invalid at
// computed-value time, so an attribute a page keeps a token in cannot be
// sent anywhere by a style sheet (`substituteIn`).

import { evaluateCondition, styleQuery } from './conditions.js';
import { matchesSyntax, validSyntax } from './syntax.js';

/**
 * How many times a tainted value has been read: an attribute an `attr()`
 * substituted, or a tainted custom property a `var()`, a `style()` or an
 * `inherit()` read. Only ever counted up, so a substitution compares it
 * before and after to know whether anything it made it from was tainted —
 * through every nested `var()`, fallback and branch — with nothing passed
 * down to them. A document with no `attr()` never moves it.
 */
let taints = 0;

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
  readonly depth: number;
  /** Which of its own are attr()-tainted; null for none, which is every
   *  set in a document with no `attr()`. */
  taint: Set<string> | null = null;

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

  /** `get`, counting a tainted value as read (`taints`): what a
   *  substitution asks. */
  read(name: string): string | undefined {
    for (let at: CustomProps | null = this; at; at = at.parent) {
      const value = at.own.get(name);
      if (value !== undefined) {
        if (value !== null && at.taint?.has(name)) taints += 1;
        return value ?? undefined;
      }
    }
    return undefined;
  }

  /** Whether the value `get` finds is attr()-tainted. */
  tainted(name: string): boolean {
    for (let at: CustomProps | null = this; at; at = at.parent) {
      const value = at.own.get(name);
      if (value !== undefined) return value !== null && !!at.taint?.has(name);
    }
    return false;
  }

  /** The whole chain as one link, with the same answers. */
  private folded(): CustomProps {
    const out = new CustomProps(null);
    const links: CustomProps[] = [];
    for (let at: CustomProps | null = this; at; at = at.parent) links.push(at);
    for (let i = links.length - 1; i >= 0; i -= 1) {
      const taint = links[i].taint;
      for (const [name, value] of links[i].own) {
        if (value === null) out.own.delete(name);
        else out.own.set(name, value);
        if (value !== null && taint?.has(name)) {
          (out.taint ??= new Set()).add(name);
        } else out.taint?.delete(name);
      }
    }
    return out;
  }
}

const FOLD_DEPTH = 16;

/** A custom property an `@property` rule registered, as the cascade
 *  reads it: whether it inherits, and its initial value, null for none. */
export interface Registration {
  inherits: boolean;
  initial: string | null;
  /** The syntax it was registered with, which a style query compares
   *  its values by (`styleQuery`). */
  syntax?: string;
}

/**
 * The custom properties an element has: `own`, its declarations in cascade
 * order, over `parent`'s. A `var()` in one of its own is resolved against
 * the rest, and one that names a property in a cycle with it, or none with
 * no fallback, leaves it no value at all (CSS Custom Properties 1 2.3, 3) —
 * but for a `registered` one, which is then as though `unset`: its
 * parent's where it inherits, its initial value where it does not, which
 * is also what `initial` gives it (CSS Properties and Values 1, 2.4).
 */
export function customProperties(
  own: ReadonlyMap<string, string>,
  parent: CustomProps | null,
  env: IfEnvironment | null = null,
  registered: ReadonlyMap<string, Registration> | null = null,
): CustomProps {
  const out = new CustomProps(parent);
  const taint = (name: string): void => {
    (out.taint ??= new Set()).add(name);
  };
  /** The parent's value, tainted as the parent's is. */
  const inherited = (name: string): string | null => {
    if (parent?.tainted(name)) taint(name);
    return parent?.get(name) ?? null;
  };
  const unset = (name: string): string | null => {
    const reg = registered?.get(name);
    return reg && !reg.inherits ? reg.initial : inherited(name);
  };
  for (const [name, value] of own) {
    const keyword = value.trim().toLowerCase();
    if (keyword === 'initial') {
      out.own.set(name, registered?.get(name)?.initial ?? null);
    } else if (keyword === 'inherit') {
      out.own.set(name, inherited(name));
    } else if (
      keyword === 'unset' ||
      keyword === 'revert' ||
      keyword === 'revert-layer'
    ) {
      // an unregistered custom property inherits, so each of these is its
      // parent's
      out.own.set(name, unset(name));
    } else {
      out.own.set(name, value);
    }
  }
  const state = new Map<string, boolean>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  /** Its value, counted as read where it is tainted, as `read` counts. */
  const resolved = (name: string): string | undefined => {
    const value = out.own.get(name);
    if (value != null && out.taint?.has(name)) taints += 1;
    return value ?? undefined;
  };
  const visit = (name: string): string | undefined => {
    // an inherited one was resolved where it was declared
    if (!own.has(name)) return parent?.read(name);
    const done = state.get(name);
    if (done === false) {
      // on the stack: a cycle, and nothing in it has a value, whatever
      // its fallbacks say
      for (let i = stack.lastIndexOf(name); i < stack.length; i += 1) {
        cyclic.add(stack[i]);
      }
      return undefined;
    }
    if (done === true) return resolved(name);
    state.set(name, false);
    stack.push(name);
    const raw = out.own.get(name);
    if (raw && hasVar(raw)) {
      // tainted as a whole where anything it was made from was
      const before = taints;
      // an `inherit()` finds the parent's, its own name's where it names
      // none
      const value = substitute(
        raw,
        visit,
        hasInherit(raw) ? inheritingEnv(env, name, parent) : env,
      );
      const made = value !== null && !cyclic.has(name);
      out.own.set(
        name,
        made ? value : registered?.has(name) ? unset(name) : null,
      );
      if (made && taints !== before) taint(name);
    }
    stack.pop();
    state.set(name, true);
    return resolved(name);
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
 *
 * The value of a property that is no custom property's: null, invalid at
 * computed-value time, where an attr()-tainted value is or is in a URL in
 * what it comes to (`taintsUrl`).
 */
export function substituteIn(
  value: string,
  props: CustomProps | null,
  env: IfEnvironment | null = null,
): string | null {
  // what a `media()` answers is the viewport's, which the properties do
  // not say
  // nor what an `inherit()` finds, which is the parent's
  // nor what an `attr()` reads, which is the element's
  if (
    !props ||
    (env &&
      (MEDIA.test(value) ||
        INHERIT_CALL.test(value) ||
        (env.attribute && ATTR_CALL.test(value)) ||
        (env.functionsReadMedia && DASHED_CALL.test(value))))
  ) {
    return substituteUntainted(value, props, env);
  }
  let memo = SUBSTITUTED.get(props);
  if (!memo) {
    memo = new Map();
    SUBSTITUTED.set(props, memo);
  }
  const hit = memo.get(value);
  if (hit !== undefined) return hit;
  const out = substituteUntainted(value, props, env);
  memo.set(value, out);
  return out;
}

/** `substitute`, or null where what it comes to has a tainted value as or
 *  in a URL. Where nothing tainted was read, which is every substitution in
 *  a document with no `attr()`, it is `substitute` once; where something
 *  was, it is made again, noting where each tainted value went. */
function substituteUntainted(
  value: string,
  props: CustomProps | null,
  env: IfEnvironment | null,
): string | null {
  const before = taints;
  const out = substitute(value, props, env);
  if (out === null || taints === before) return out;
  const ranges: number[] = [];
  const again = substitute(value, props, env, [], ranges);
  return again === null || taintsUrl(again, ranges) ? null : again;
}

/**
 * Whether one of `value`'s attr()-tainted ranges (`ranges`, a start and an
 * end each) is or is in a `<url>` (CSS Values 5, 8.7.2): a `url()`, a
 * `src()`, or a string an `image()` or an `image-set()` takes for one. A
 * tainted value elsewhere is no URL, though it be beside one: an
 * `image("a.png", attr(c type(<color>)))` fades to the attribute's colour.
 */
export function taintsUrl(value: string, ranges: readonly number[]): boolean {
  const meets = (from: number, to: number): boolean => {
    for (let k = 0; k < ranges.length; k += 2) {
      if (ranges[k] < to && ranges[k + 1] > from) return true;
    }
    return false;
  };
  // the function each bracket open at `i` is, lowercase, '' for none
  const open: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      const end = stringEnd(value, i);
      const close = end < 0 ? value.length : end + 1;
      if (URL_STRINGS.has(open[open.length - 1] ?? '') && meets(i, close)) {
        return true;
      }
      i = close - 1;
    } else if (c === '(' || c === '[' || c === '{') {
      let at = i;
      while (at > 0 && isNameChar(value[at - 1])) at -= 1;
      const name = c === '(' ? value.slice(at, i).toLowerCase() : '';
      if (name === 'url' || name === 'src') {
        const close = closingParen(value, i + 1);
        const end = close < 0 ? value.length : close + 1;
        if (meets(at, end)) return true;
        i = end - 1;
        continue;
      }
      open.push(name);
    } else if (c === ')' || c === ']' || c === '}') {
      open.pop();
    }
  }
  return false;
}

/** The functions a string in which is a URL (CSS Images 4, 2.2 and 2.4). */
const URL_STRINGS = new Set(['image', 'image-set', '-webkit-image-set']);

const SUBSTITUTED = new WeakMap<CustomProps, Map<string, string | null>>();

const MEDIA = /(?:^|[^\w-])media\(/i;

/** Whether a value has a `var()`, an `if()`, an `inherit()` or a custom
 *  function's call in it: whether it is read only once the element's
 *  custom properties are known. */
export function hasVar(value: string): boolean {
  return VAR.test(value) || (value.includes('--') && DASHED_CALL.test(value));
}

/** Whether a value has an `inherit()` in it, which reads the parent. */
export function hasInherit(value: string): boolean {
  return INHERIT_CALL.test(value);
}

/**
 * `env` for a value of `property` with an `inherit()` in it: one whose
 * `inherited` finds a custom property in `parent`, the parent's custom
 * properties, and anything else where `env` would.
 */
export function inheritingEnv(
  env: IfEnvironment | null,
  property: string,
  parent: CustomProps | null,
): IfEnvironment {
  return {
    ...(env ?? NO_ENV),
    property,
    inherited: (name) =>
      name.startsWith('--') ? parent?.read(name) : env?.inherited?.(name),
  };
}

/** What nothing answers: no media query and no `@supports` holds. */
const NO_ENV: IfEnvironment = {
  media: () => false,
  supports: () => false,
};

/**
 * What an `if()` asks beyond the element's custom properties: whether a
 * media query holds, for `media()`, and a `@supports` condition, for
 * `supports()`. Without one, both are unknown, and hold nowhere. And what a
 * custom function's call asks: the `@function` its name finds, and whether
 * a value is of a type its parameters or its `returns` name.
 */
export interface IfEnvironment {
  media(query: string): boolean;
  supports(condition: string): boolean;
  /** The `@function` a dashed function names, or null for none, which
   *  leaves the call no value. */
  fn?(name: string): CustomFunction | null;
  /** Whether `value` is of `syntax` (`syntax.ts`); absent, every value is. */
  matches?(value: string, syntax: string): boolean;
  /** Whether some `@function` is chosen by a media query, or holds one,
   *  so that what a call comes to is the viewport's to say. */
  functionsReadMedia?: boolean;
  /** What an `inherit()` of `name` finds: the parent's custom property of
   *  the name, or the parent's computed value of the property, as text;
   *  undefined for none. Absent, `inherit()` finds nothing. */
  inherited?(name: string): string | undefined;
  /** The property the value is the declaration of, which an `inherit()`
   *  with no name inherits. */
  property?: string;
  /** The element's attribute of a name, which an `attr()` reads (CSS
   *  Values 5, 7.7), in a namespace where one is given and in none where
   *  it is null; undefined where it has none. Absent, an `attr()` is
   *  left as it is written, for what reads it to answer (`content`'s). */
  attribute?(name: string, namespace?: string | null): string | undefined;
}

/**
 * A custom function (CSS Mixins 1, 2.1): its parameters, the type it
 * returns, and its body, in the order written.
 */
export interface CustomFunction {
  params: readonly FunctionParam[];
  /** The syntax its `result` is held to, or null for any (`type(*)`). */
  returns: string | null;
  body: readonly FunctionItem[];
}

export interface FunctionParam {
  /** As written: a custom property's name, case and all. */
  name: string;
  /** The syntax an argument is held to, or null for any. */
  syntax: string | null;
  /** What it is where the call gives it nothing, or something not of its
   *  type; null for none, which leaves it no value. */
  fallback: string | null;
}

/** A descriptor of a function's body — `result`, or a local custom
 *  property — or an `@media` block of more of them. A `@supports` block
 *  is read as the sheet is, and its descriptors are the body's. */
export type FunctionItem =
  | { kind: 'descriptor'; name: string; value: string }
  | { kind: 'media'; condition: string; body: readonly FunctionItem[] };

/**
 * Whether each `var()` in a value is one: closed, naming a custom property,
 * and with a fallback, if it has one, that could be a declaration's value —
 * no `;` or `!` outside its brackets, no string a newline cuts off. One that
 * is not makes its declaration invalid as it is parsed, not as it is used,
 * so the declaration before it stands (CSS Custom Properties 1 3). An
 * `if()` has to close, and the `var()`s in its branches be ones.
 */
export function validVars(value: string): boolean {
  let i = 0;
  for (;;) {
    const found = findVar(value, i);
    if (!found) return true;
    const { open, kind } = found;
    let close = closingParen(value, open);
    // the value's end closes what it ends inside
    if (close < 0) {
      if (unbalanced(value.slice(open))) return false;
      close = value.length;
    }
    const inner = value.slice(open, close);
    if (kind === 'attr') {
      const comma = topLevelComma(inner);
      const head = comma < 0 ? inner : inner.slice(0, comma);
      // a name or a type a substitution gives is read once it has
      if (hasVar(head) ? !validArguments(head) : !attrHead(head)) return false;
      if (comma >= 0) {
        const fallback = inner.slice(comma + 1);
        if (topLevel(fallback, ';') >= 0 || topLevel(fallback, '!') >= 0) {
          return false;
        }
        if (hasVar(fallback) && !validVars(fallback)) return false;
      }
      i = close + 1;
      continue;
    }
    if (kind === 'if' || kind === 'fn') {
      if (!(kind === 'if' ? validIf(inner) : validArguments(inner))) {
        return false;
      }
      i = close + 1;
      continue;
    }
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    // an `inherit()` may name a property, or nothing: the one declared
    const named = kind === 'inherit' ? !name || INHERIT_NAME.test(name) : false;
    if (!named && !NAME.test(name)) return false;
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

const VAR = /(?:^|[^\w-])(?:var|if|inherit|attr)\(/i;

/** An `attr()`, which reads the element and not its custom properties. */
const ATTR_CALL = /(?:^|[^\w-])attr\(/i;

const INHERIT_CALL = /(?:^|[^\w-])inherit\(/i;

/** What an `inherit()` may name: a custom property, or a property. */
const INHERIT_NAME = /^-?[a-z][a-z-]*$/i;

/** A custom function's call: a dashed ident straight before a bracket. */
const DASHED_CALL = /(?:^|[^\w-])--(?:[\w-]|[^\x00-\x7f])+\(/;

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
  env: IfEnvironment | null = null,
  /** The custom functions being evaluated, outermost first, a call of any
   *  of which again is a cycle. */
  calls: readonly string[] = [],
  /** Where the attr()-tainted replacements went in what comes back, a
   *  start and an end each, where it is wanted: each function a tainted
   *  value went into the making of is tainted whole. */
  tainted: number[] | null = null,
): string | null {
  const get =
    typeof lookup === 'function'
      ? lookup
      : (name: string) => lookup?.read(name);
  let out = '';
  let i = 0;
  for (;;) {
    const found = findVar(value, i);
    if (!found) break;
    const { at, open, kind } = found;
    let close = closingParen(value, open);
    // a function the value ends inside is closed by its end, as CSS's
    // tokenizer closes it (CSS Syntax 3, 5.4.9)
    if (close < 0) {
      if (unbalanced(value.slice(open))) return null;
      close = value.length;
    }
    const inner = value.slice(open, close);
    const before = taints;
    let replacement: string | undefined | null;
    if (kind === 'attr') {
      replacement = env?.attribute
        ? attrValue(inner, get, env, calls)
        : value.slice(at, close + 1);
      if (replacement === null) return null;
    } else if (kind === 'if') {
      replacement = chooseBranch(inner, get, env, calls);
      if (replacement === null) return null;
    } else if (kind === 'fn') {
      const name = value.slice(at, open - 1);
      replacement = callFunction(name, inner, get, env, calls);
      if (replacement === null) return null;
    } else {
      const comma = topLevelComma(inner);
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      if (kind === 'inherit') {
        // the parent's value of what it names, a custom property's or a
        // property's, or of the property declared where it names none
        if (name && !NAME.test(name) && !INHERIT_NAME.test(name)) return null;
        const of = name ? unescapeName(name) : env?.property;
        replacement = of ? env?.inherited?.(of) : undefined;
      } else {
        if (!NAME.test(name)) return null;
        replacement = get(unescapeName(name));
      }
      if (replacement === undefined) {
        if (comma < 0) return null;
        const fallback = inner.slice(comma + 1);
        const resolved = hasVar(fallback)
          ? substitute(fallback, get, env, calls)
          : fallback;
        if (resolved === null) return null;
        replacement = resolved;
      }
    }
    // a space either side, where nothing parts it from what is around it
    // already, so the tokenizer joins nothing that was apart
    out += value.slice(i, at);
    if (out && !/[\s(,]$/.test(out)) out += ' ';
    const start = out.length;
    out += replacement.trim();
    if (tainted && taints !== before) tainted.push(start, out.length);
    const next = value[close + 1];
    if (next !== undefined && !/[\s),]/.test(next)) out += ' ';
    i = close + 1;
  }
  const whole = out + value.slice(i);
  if (tainted?.length) {
    // what the trim takes from its start moves every range back
    const lead = whole.length - whole.trimStart().length;
    for (let k = 0; k < tainted.length; k += 1) tainted[k] -= lead;
  }
  return whole.trim();
}

/** The units a number in an attribute may be given by an `attr()`'s type
 *  (CSS Values 5, 7.7.1, `<attr-unit>`). */
const ATTR_UNIT =
  /^(?:%|px|em|rem|ex|rex|cap|rcap|ch|rch|ic|ric|lh|rlh|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max)|cm|mm|q|in|pt|pc|deg|grad|rad|turn|s|ms|hz|khz|dpi|dpcm|dppx|x|fr)$/i;

const ATTR_NUMBER = /^[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?$/i;

/**
 * What an `attr()` comes to (CSS Values 5, 7.7): the element's attribute,
 * as a string where it gives no type, parsed as its type where it does —
 * `type(<syntax>)`, `number` or a unit, which a number becomes a dimension
 * of. An attribute it does not have, or that is not of its type, is its
 * fallback; with none, a typed one has no value and an untyped one is the
 * empty string. Null for a call that is no `attr()` at all.
 *
 * Its name and type are substituted first, so `attr(var(--x))` reads the
 * attribute `--x` names, and a name and type that are none once they are
 * is its fallback, or no value (8.7.1). A name in a namespace is one an
 * `@namespace` rule declared the prefix of (`namespacePrefix`); any other
 * prefix names no attribute. What the attribute holds, once it is read,
 * is attr()-tainted (`taints`), whether it parsed or the fallback stood
 * for it.
 */
function attrValue(
  inner: string,
  get: (name: string) => string | undefined,
  env: IfEnvironment,
  calls: readonly string[],
): string | null {
  const comma = topLevelComma(inner);
  let headText = comma < 0 ? inner : inner.slice(0, comma);
  if (hasVar(headText)) headText = substitute(headText, get, env, calls) ?? '';
  const head = attrHead(headText);
  const fallback = (typed: boolean): string | null => {
    if (comma < 0) return typed ? null : '""';
    const text = inner.slice(comma + 1);
    return hasVar(text) ? substitute(text, get, env, calls) : text.trim();
  };
  if (!head) return fallback(true);
  const { name, prefix, syntax, unit, number } = head;
  const typed = syntax !== null || number || unit !== null;
  let namespace: string | null = null;
  if (prefix) {
    const declared = namespaceOfPrefix(prefix);
    if (declared === undefined) return fallback(typed);
    namespace = declared;
  }
  const raw = env.attribute!(unescapeName(name), namespace);
  if (raw === undefined) return fallback(typed);
  taints += 1;
  // an attribute whose value reads itself, through others or not, has none
  const key = `attr ${name.toLowerCase()}`;
  if (calls.includes(key)) return null;
  if (!typed) return cssString(raw);
  if (unit !== null || number) {
    const n = raw.trim();
    if (!ATTR_NUMBER.test(n)) return fallback(true);
    if (number) return n;
    if (!ATTR_UNIT.test(unit!)) return fallback(true);
    return `${n}${unit!.toLowerCase()}`;
  }
  // the attribute is read as a value, what it substitutes in it too
  const parsed = hasVar(raw)
    ? substitute(raw, get, env, [...calls, key])
    : raw.trim();
  if (parsed === null || !parsed) return fallback(true);
  if (!matchesSyntax(parsed, syntax!)) return fallback(true);
  // substituted as the value it was parsed as, which serializes a
  // dimension's unit in lowercase (CSS Values 4, 4.2): `3EM` is `3em`
  return NUMERIC_SYNTAX.test(syntax!)
    ? parsed.replace(/(\d\.?)([a-z]+)\b/gi, (_, n, u) => n + u.toLowerCase())
    : parsed;
}

/** A syntax with a dimension in it, whose units serialize lowercase. */
const NUMERIC_SYNTAX =
  /<(?:length|length-percentage|angle|time|resolution|flex|frequency)>/;

/** An `attr()`'s name and type, before its fallback: null where it is
 *  none, which makes its declaration none as it is parsed. Its prefix is
 *  the namespace's as written, '' for `|name`, which is no namespace, and
 *  null for none; `*` is none, since an `attr()` names one attribute (CSS
 *  Values 5, 8.7). A `type()` of a URL is none either: no attribute can
 *  be one (8.7.2). */
function attrHead(text: string): {
  name: string;
  prefix: string | null;
  syntax: string | null;
  unit: string | null;
  number: boolean;
} | null {
  const m =
    /^\s*(?:((?:[\w-]|[^\x00-\x7f]|\\.)*)\|)?((?:[\w-]|[^\x00-\x7f]|\\.)+)\s*([\s\S]*)$/.exec(
      text,
    );
  if (!m) return null;
  const name = m[2];
  const prefix = m[1] ?? null;
  const typeText = m[3].trim();
  if (/^type\(/i.test(typeText)) {
    let end = closingParen(typeText, 5);
    if (end >= 0 && typeText.slice(end + 1).trim()) return null;
    if (end < 0) end = typeText.length;
    const syntax = typeText.slice(5, end).trim();
    if (!validSyntax(syntax) || /<url>/i.test(syntax)) return null;
    return { name, prefix, syntax, unit: null, number: false };
  }
  if (/^number$/i.test(typeText)) {
    return { name, prefix, syntax: null, unit: null, number: true };
  }
  if (!typeText || /^raw-string$/i.test(typeText)) {
    return { name, prefix, syntax: null, unit: null, number: false };
  }
  // an ident is a unit, which only a unit's name is the type of; and
  // anything else is no type
  if (!/^(?:%|-?[a-z_][\w-]*)$/i.test(typeText)) return null;
  return { name, prefix, syntax: null, unit: typeText, number: false };
}

/**
 * The prefix an `attr()` in a style sheet is given for a namespace an
 * `@namespace` rule declared there (CSS Namespaces 3): a sheet's prefix
 * stands for its URL in that sheet alone, so the parser writes the URL in
 * where it reads one (`namespacedAttrs`), as an ident that holds it.
 */
export function namespacePrefix(url: string): string {
  let hex = '';
  for (let i = 0; i < url.length; i += 1) {
    hex += url.charCodeAt(i).toString(16).padStart(4, '0');
  }
  return `${NAMESPACE_MARK}${hex}`;
}

const NAMESPACE_MARK = '-rx-ns-';

/** The URL a prefix `namespacePrefix` wrote stands for, null for a
 *  namespace of nothing, which is none; undefined for any other prefix,
 *  which no `@namespace` declared. */
function namespaceOfPrefix(prefix: string): string | null | undefined {
  if (!prefix.startsWith(NAMESPACE_MARK)) return undefined;
  const hex = prefix.slice(NAMESPACE_MARK.length);
  if (hex.length % 4 || /[^0-9a-f]/.test(hex)) return undefined;
  let url = '';
  for (let i = 0; i < hex.length; i += 4) {
    url += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  return url || null;
}

/**
 * `value` with the namespace prefix of each `attr()` in it that
 * `namespaces` declares written as the URL it stands for
 * (`namespacePrefix`). One it does not declare is left as written, and
 * names no attribute.
 */
export function namespacedAttrs(
  value: string,
  namespaces: ReadonlyMap<string, string>,
): string {
  return value.replace(
    /(?<![\w-])(attr\(\s*)((?:[\w-]|[^\x00-\x7f])+)\|(?!=)/gi,
    (all, open: string, prefix: string) => {
      const url = namespaces.get(prefix);
      return url === undefined ? all : `${open}${namespacePrefix(url)}|`;
    },
  );
}

/** `text` as a CSS string, quoted and escaped (CSSOM, "serialize a
 *  string"). */
function cssString(text: string): string {
  return `"${text.replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, '\\a ')}"`;
}

/**
 * What a call of the custom function `name` comes to (CSS Mixins 1, 2.3),
 * or null where it has no value: no `@function` of the name, a call inside
 * one of the functions it calls (a cycle), more arguments than parameters,
 * no `result`, or a `result` that is not of the type it `returns`.
 *
 * Each argument is substituted where the call is, as any other part of the
 * value is, and one that is not of its parameter's type is as though not
 * given, its default standing for it. In the body a `var()` finds a local
 * first, then a parameter, then what the caller would have found — the
 * element's custom properties, or the scope of the function whose body
 * makes the call — so a function sees what it is called from. A local or a
 * default can name another; one that comes round to itself has no value,
 * whatever its fallback says, as a custom property in a cycle has none.
 */
function callFunction(
  name: string,
  inner: string,
  get: (name: string) => string | undefined,
  env: IfEnvironment | null,
  calls: readonly string[],
): string | null {
  const fn = env?.fn?.(name) ?? null;
  if (!fn || calls.includes(name)) return null;
  const args = splitArguments(inner);
  if (args.length > fn.params.length) return null;
  const within = [...calls, name];
  const matches = (v: string, syntax: string | null): boolean =>
    syntax === null || !env?.matches || env.matches(v, syntax);
  // the arguments as the caller sees them; null is a parameter with no
  // value, which a `var()` of it falls back from
  const bound = new Map<string, string | null>();
  const defaults = new Map<string, string>();
  const syntaxes = new Map<string, string | null>();
  fn.params.forEach((param, k) => {
    let v: string | null = k < args.length ? args[k] : null;
    if (v !== null && hasVar(v)) v = substitute(v, get, env, calls);
    if (v !== null && !matches(v, param.syntax)) v = null;
    syntaxes.set(param.name, param.syntax);
    if (v === null && param.fallback !== null) {
      defaults.set(param.name, param.fallback);
    } else {
      bound.set(param.name, v);
    }
  });
  // the body as its conditions hold: the last `result` and the last of
  // each local stand
  const locals = new Map<string, string>();
  let result: string | null = null;
  const read = (items: readonly FunctionItem[]): void => {
    for (const item of items) {
      if (item.kind === 'media') {
        if (env?.media(item.condition)) read(item.body);
      } else if (item.name === 'result') {
        result = item.value;
      } else {
        locals.set(item.name, item.value);
      }
    }
  };
  read(fn.body);
  const done = new Map<string, string | null>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  const own = (
    key: string,
    raw: string,
    syntax: string | null,
    lookup: (name: string) => string | undefined,
  ): string | null => {
    const known = done.get(key);
    if (known !== undefined) return known;
    const on = stack.indexOf(key);
    if (on >= 0) {
      for (let j = on; j < stack.length; j += 1) cyclic.add(stack[j]);
      return null;
    }
    stack.push(key);
    let v: string | null = hasVar(raw)
      ? substitute(raw, lookup, env, within)
      : raw;
    stack.pop();
    if (cyclic.has(key) || (v !== null && !matches(v, syntax))) v = null;
    done.set(key, v);
    return v;
  };
  // the parameters, which a default reads beside the others, and under
  // them what the caller sees
  const params = (n: string): string | undefined => {
    if (bound.has(n)) return bound.get(n) ?? undefined;
    const fallback = defaults.get(n);
    if (fallback === undefined) return get(n);
    const syntax = syntaxes.get(n) ?? null;
    return own(`param ${n}`, fallback, syntax, params) ?? undefined;
  };
  // and the body's locals over them
  const scope = (n: string): string | undefined => {
    const local = locals.get(n);
    // `initial` on a local is no local, and what it would hide stands
    if (local === undefined || /^\s*initial\s*$/i.test(local)) {
      return params(n);
    }
    return own(`local ${n}`, local, null, scope) ?? undefined;
  };
  const written: string | null = result;
  if (written === null) return null;
  const out = hasVar(written)
    ? substitute(written, scope, env, within)
    : written;
  if (out === null || !matches(out, fn.returns)) return null;
  return out;
}

/** A call's arguments: its value cut at each comma outside brackets, an
 *  argument wrapped whole in `{}` unwrapped, which is how one holds a
 *  comma of its own. A call of nothing has none. */
function splitArguments(inner: string): string[] {
  if (!inner.trim()) return [];
  return topLevelSplit(inner, ',').map((arg) => {
    const t = arg.trim();
    return wrappedInBraces(t) ? t.slice(1, -1).trim() : t;
  });
}

/** Whether `text` is one `{}` block, its brace closing at its end. */
function wrappedInBraces(text: string): boolean {
  if (text[0] !== '{' || !text.endsWith('}')) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      const end = stringEnd(text, i);
      if (end < 0) return false;
      i = end;
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0 && i < text.length - 1) return false;
    }
  }
  return depth === 0;
}

/** Whether a call's arguments are ones as it is parsed: values, with no
 *  `;` or `!` outside their brackets, and the `var()`s in them ones. */
function validArguments(inner: string): boolean {
  if (topLevel(inner, ';') >= 0 || topLevel(inner, '!') >= 0) return false;
  return !hasVar(inner) || validVars(inner);
}

/**
 * The value an `if()` stands for: the first branch whose condition holds,
 * its own `var()`s and `if()`s replaced — or nothing where none holds, so
 * that a declaration of nothing else is invalid at computed-value time —
 * or null where it is no `if()`, or the branch it takes has a `var()` with
 * nothing to stand for it. Branches are `condition: value`, separated by
 * `;`, and `else` holds always.
 */
function chooseBranch(
  inner: string,
  get: (name: string) => string | undefined,
  env: IfEnvironment | null,
  calls: readonly string[],
): string | null {
  const fill = (text: string): string | null =>
    hasVar(text) ? substitute(text, get, env, calls) : text;
  for (const branch of topLevelSplit(inner, ';')) {
    if (!branch.trim()) continue;
    const colon = topLevel(branch, ':');
    if (colon < 0) return null;
    const test = branch.slice(0, colon).trim();
    const holds = /^else$/i.test(test)
      ? true
      : evaluateCondition(test, (name, query) => {
          if (name === 'style') return styleQuery(query, get, fill);
          if (name === 'media') {
            if (!env) return undefined;
            const condition =
              query.startsWith('(') || /^not\s/i.test(query)
                ? query
                : `(${query})`;
            return env.media(condition);
          }
          if (name === 'supports') {
            if (!env) return undefined;
            // `supports(display: grid)` is a declaration in no brackets
            const condition = /^[a-z-]+\s*:/i.test(query)
              ? `(${query})`
              : query;
            return env.supports(condition);
          }
          return undefined;
        });
    if (holds === null) return null;
    if (holds) return fill(branch.slice(colon + 1));
  }
  return '';
}

/** Whether an `if()`'s branches are ones as it is parsed: each a
 *  condition, or `else`, a `:` and a value, and the `var()`s in them
 *  ones. Which branch holds is the element's to say. */
function validIf(inner: string): boolean {
  for (const branch of topLevelSplit(inner, ';')) {
    if (!branch.trim()) continue;
    const colon = topLevel(branch, ':');
    if (colon < 0) return false;
    const test = branch.slice(0, colon).trim();
    if (
      !/^else$/i.test(test) &&
      evaluateCondition(test, () => undefined) === null
    ) {
      return false;
    }
  }
  return !hasVar(inner) || validVars(inner);
}

/** `value` cut at each `sep` outside brackets and strings. */
function topLevelSplit(value: string, sep: string): string[] {
  const out: string[] = [];
  let rest = value;
  for (;;) {
    const at = topLevel(rest, sep);
    if (at < 0) break;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  out.push(rest);
  return out;
}

/** A substitution function in a value: where it starts, where its
 *  bracket opens, and which it is — `fn` a custom function's call. */
interface Found {
  at: number;
  open: number;
  kind: 'var' | 'if' | 'inherit' | 'fn' | 'attr';
}

/** The next `var(`, `if(`, `inherit(` or `--name(` from `from` that is a
 *  function of its own, and in no string; null where there is none. */
function findVar(value: string, from: number): Found | null {
  const n = value.length;
  for (let i = from; i < n; i += 1) {
    const c = value[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = stringEnd(value, i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (i > 0 && isNameChar(value[i - 1])) continue;
    if (c === 'v' || c === 'V') {
      if (value.slice(i, i + 4).toLowerCase() === 'var(') {
        return { at: i, open: i + 4, kind: 'var' };
      }
    } else if (c === 'i' || c === 'I') {
      if (value.slice(i, i + 3).toLowerCase() === 'if(') {
        return { at: i, open: i + 3, kind: 'if' };
      }
      if (value.slice(i, i + 8).toLowerCase() === 'inherit(') {
        return { at: i, open: i + 8, kind: 'inherit' };
      }
    } else if (c === 'a' || c === 'A') {
      if (value.slice(i, i + 5).toLowerCase() === 'attr(') {
        return { at: i, open: i + 5, kind: 'attr' };
      }
    } else if (c === '-' && value[i + 1] === '-') {
      let end = i + 2;
      while (end < n && isNameChar(value[end])) end += 1;
      if (end > i + 2 && value[end] === '(') {
        return { at: i, open: end + 1, kind: 'fn' };
      }
      i = end - 1;
    }
  }
  return null;
}

/** Whether `c` may be in a name: a letter, a digit, `_`, `-`, or anything
 *  past ASCII. */
function isNameChar(c: string): boolean {
  return /[\w-]/.test(c) || c.charCodeAt(0) > 0x7f;
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

/** `value` with the brackets it ends inside closed, as CSS's tokenizer
 *  closes them at the end of what it reads (CSS Syntax 3, 5.4.9): a value
 *  set on its own, written into a list of declarations, where the `;`
 *  after it would be read inside them. */
export function closeBrackets(value: string): string {
  const open: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      const end = stringEnd(value, i);
      if (end < 0) return value;
      i = end;
    } else if (c === '(' || c === '[' || c === '{') {
      open.push(c === '(' ? ')' : c === '[' ? ']' : '}');
    } else if (c === ')' || c === ']' || c === '}') {
      if (open.pop() !== c) return value;
    }
  }
  return open.length ? value + open.reverse().join('') : value;
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
