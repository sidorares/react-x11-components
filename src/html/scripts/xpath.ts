// XPath 1.0 over `<Html>`'s DOM, for `document.evaluate`.
//
// draw.io reads every diagram with it. It is the host's, a pure module over
// the tree, because an expression walks every node it can reach and a walk
// through the facade would be an op for each: what crosses is an expression
// and the prefixes it names (`prefixesIn`), which a page's resolver answers
// in the page, and what comes back is numbers. An attribute is no node of
// the tree, so one stands for itself here (`XAttr`).
import { Comment, Element, ProcessingInstruction, Text } from 'domhandler';
import type { AnyNode, ParentNode } from 'domhandler';

export const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** An attribute, as an expression selects one. */
export class XAttr {
  constructor(
    readonly el: Element,
    readonly name: string,
  ) {}
}
export type XNode = AnyNode | XAttr;
export type XValue = boolean | number | string | XNode[];

export class XPathSyntaxError extends Error {}

type Expr =
  | { t: 'or' | 'and'; a: Expr; b: Expr }
  | { t: 'cmp'; op: string; a: Expr; b: Expr }
  | { t: 'math'; op: string; a: Expr; b: Expr }
  | { t: 'neg'; a: Expr }
  | { t: 'union'; a: Expr; b: Expr }
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'var'; name: string }
  | { t: 'call'; name: string; args: Expr[] }
  | { t: 'path'; root: boolean; from: Expr | null; steps: Step[] }
  | { t: 'filter'; a: Expr; preds: Expr[] };

interface Test {
  kind: 'name' | 'any' | 'prefix' | 'node' | 'text' | 'comment' | 'pi';
  prefix?: string;
  local?: string;
  /** A processing instruction's target, for `processing-instruction("x")`. */
  target?: string;
}
interface Step {
  axis: string;
  test: Test;
  preds: Expr[];
}

const AXES = new Set([
  'ancestor',
  'ancestor-or-self',
  'attribute',
  'child',
  'descendant',
  'descendant-or-self',
  'following',
  'following-sibling',
  'namespace',
  'parent',
  'preceding',
  'preceding-sibling',
  'self',
]);
const NODE_TYPES = new Set([
  'node',
  'text',
  'comment',
  'processing-instruction',
]);
const NAME_START =
  'A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const NCNAME = `[${NAME_START}][${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F\\u2040]*`;
const TOKEN = new RegExp(
  `[ \\t\\r\\n]*(?:(\\.\\.|::|//|!=|<=|>=|[()\\[\\]@,/|+=<>*.-])|(\\d+(?:\\.\\d*)?|\\.\\d+)|"([^"]*)"|'([^']*)'|\\$(${NCNAME}(?::${NCNAME})?)|(${NCNAME}(?::(?:${NCNAME}|\\*))?))`,
  'y',
);

type Token =
  | { k: 'op'; v: string }
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'var'; v: string }
  | { k: 'name'; v: string };

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    if (/^[ \t\r\n]*$/.test(text.slice(TOKEN.lastIndex))) break;
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m) throw new XPathSyntaxError(`Unexpected text at ${at}.`);
    if (m[1] !== undefined) out.push({ k: 'op', v: m[1] });
    else if (m[2] !== undefined) out.push({ k: 'num', v: Number(m[2]) });
    else if (m[3] !== undefined) out.push({ k: 'str', v: m[3] });
    else if (m[4] !== undefined) out.push({ k: 'str', v: m[4] });
    else if (m[5] !== undefined) out.push({ k: 'var', v: m[5] });
    else out.push({ k: 'name', v: m[6] });
  }
  return out;
}

/** The parser, by the grammar's productions (XPath 1.0, 3.7's rules for a
 *  `*` and a name that could be an operator among them). */
class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}
  private peek(at = 0): Token | undefined {
    return this.tokens[this.i + at];
  }
  private isOp(v: string, at = 0): boolean {
    const t = this.peek(at);
    return t?.k === 'op' && t.v === v;
  }
  private take(v: string): boolean {
    if (!this.isOp(v)) return false;
    this.i += 1;
    return true;
  }
  private need(v: string): void {
    if (!this.take(v)) throw new XPathSyntaxError(`Expected ${v}.`);
  }
  /** An operator's name where a name stands (3.7): after anything that can
   *  end an expression. */
  private word(v: string): boolean {
    const t = this.peek();
    if (t?.k !== 'name' || t.v !== v) return false;
    const before = this.tokens[this.i - 1];
    if (!before) return false;
    if (before.k === 'op' && !['.', '..', ')', ']', '*'].includes(before.v)) {
      return false;
    }
    this.i += 1;
    return true;
  }
  parse(): Expr {
    const e = this.or();
    if (this.i < this.tokens.length) {
      throw new XPathSyntaxError('Unexpected text after the expression.');
    }
    return e;
  }
  private or(): Expr {
    let a = this.and();
    while (this.word('or')) a = { t: 'or', a, b: this.and() };
    return a;
  }
  private and(): Expr {
    let a = this.equality();
    while (this.word('and')) a = { t: 'and', a, b: this.equality() };
    return a;
  }
  private equality(): Expr {
    let a = this.relational();
    for (;;) {
      if (this.take('=')) a = { t: 'cmp', op: '=', a, b: this.relational() };
      else if (this.take('!=')) {
        a = { t: 'cmp', op: '!=', a, b: this.relational() };
      } else return a;
    }
  }
  private relational(): Expr {
    let a = this.additive();
    for (;;) {
      const t = this.peek();
      if (t?.k === 'op' && ['<', '>', '<=', '>='].includes(t.v)) {
        this.i += 1;
        a = { t: 'cmp', op: t.v, a, b: this.additive() };
      } else return a;
    }
  }
  private additive(): Expr {
    let a = this.multiplicative();
    for (;;) {
      if (this.take('+'))
        a = { t: 'math', op: '+', a, b: this.multiplicative() };
      else if (this.take('-')) {
        a = { t: 'math', op: '-', a, b: this.multiplicative() };
      } else return a;
    }
  }
  private multiplicative(): Expr {
    let a = this.unary();
    for (;;) {
      if (this.isOp('*')) {
        this.i += 1;
        a = { t: 'math', op: '*', a, b: this.unary() };
      } else if (this.word('div')) {
        a = { t: 'math', op: 'div', a, b: this.unary() };
      } else if (this.word('mod')) {
        a = { t: 'math', op: 'mod', a, b: this.unary() };
      } else return a;
    }
  }
  private unary(): Expr {
    if (this.take('-')) return { t: 'neg', a: this.unary() };
    return this.union();
  }
  private union(): Expr {
    let a = this.pathExpr();
    while (this.take('|')) a = { t: 'union', a, b: this.pathExpr() };
    return a;
  }
  private startsFilter(): boolean {
    const t = this.peek();
    if (!t) return false;
    if (t.k === 'num' || t.k === 'str' || t.k === 'var') return true;
    if (t.k === 'op') return t.v === '(';
    const next = this.peek(1);
    return (
      t.k === 'name' &&
      next?.k === 'op' &&
      next.v === '(' &&
      !NODE_TYPES.has(t.v)
    );
  }
  private pathExpr(): Expr {
    if (!this.startsFilter()) return this.location();
    let e = this.primary();
    const preds = this.predicates();
    if (preds.length) e = { t: 'filter', a: e, preds };
    if (this.isOp('/') || this.isOp('//')) {
      const steps: Step[] = [];
      if (this.take('//')) steps.push(ANY_DESCENDANT());
      else this.need('/');
      this.relative(steps);
      return { t: 'path', root: false, from: e, steps };
    }
    return e;
  }
  private primary(): Expr {
    const t = this.peek()!;
    this.i += 1;
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'var') return { t: 'var', name: t.v };
    if (t.k === 'op') {
      const e = this.or();
      this.need(')');
      return e;
    }
    this.need('(');
    const args: Expr[] = [];
    if (!this.take(')')) {
      do args.push(this.or());
      while (this.take(','));
      this.need(')');
    }
    return { t: 'call', name: (t as { v: string }).v, args };
  }
  private location(): Expr {
    const steps: Step[] = [];
    let root = false;
    if (this.take('/')) {
      root = true;
      const t = this.peek();
      const more =
        t &&
        (t.k === 'name' ||
          (t.k === 'op' && ['.', '..', '@', '*'].includes(t.v)));
      if (!more) return { t: 'path', root, from: null, steps };
    } else if (this.take('//')) {
      root = true;
      steps.push(ANY_DESCENDANT());
    }
    this.relative(steps);
    return { t: 'path', root, from: null, steps };
  }
  private relative(steps: Step[]): void {
    for (;;) {
      steps.push(this.step());
      if (this.take('//')) steps.push(ANY_DESCENDANT());
      else if (!this.take('/')) return;
    }
  }
  private step(): Step {
    if (this.take('.'))
      return { axis: 'self', test: { kind: 'node' }, preds: [] };
    if (this.take('..')) {
      return { axis: 'parent', test: { kind: 'node' }, preds: [] };
    }
    let axis = 'child';
    if (this.take('@')) axis = 'attribute';
    else {
      const t = this.peek();
      if (t?.k === 'name' && this.isOp('::', 1)) {
        if (!AXES.has(t.v)) throw new XPathSyntaxError(`No axis ${t.v}.`);
        axis = t.v;
        this.i += 2;
      }
    }
    return { axis, test: this.nodeTest(), preds: this.predicates() };
  }
  private nodeTest(): Test {
    if (this.take('*')) return { kind: 'any' };
    const t = this.peek();
    if (t?.k !== 'name') throw new XPathSyntaxError('Expected a node test.');
    this.i += 1;
    if (NODE_TYPES.has(t.v) && this.take('(')) {
      let target: string | undefined;
      const arg = this.peek();
      if (t.v === 'processing-instruction' && arg?.k === 'str') {
        target = arg.v;
        this.i += 1;
      }
      this.need(')');
      if (t.v === 'node') return { kind: 'node' };
      if (t.v === 'text') return { kind: 'text' };
      if (t.v === 'comment') return { kind: 'comment' };
      return { kind: 'pi', target };
    }
    const colon = t.v.indexOf(':');
    if (colon < 0) return { kind: 'name', local: t.v };
    const prefix = t.v.slice(0, colon);
    const local = t.v.slice(colon + 1);
    return local === '*'
      ? { kind: 'prefix', prefix }
      : { kind: 'name', prefix, local };
  }
  private predicates(): Expr[] {
    const preds: Expr[] = [];
    while (this.take('[')) {
      preds.push(this.or());
      this.need(']');
    }
    return preds;
  }
}
const ANY_DESCENDANT = (): Step => ({
  axis: 'descendant-or-self',
  test: { kind: 'node' },
  preds: [],
});

/** What an expression is compiled to. */
export type CompiledXPath = Expr;
export function compileXPath(text: string): CompiledXPath {
  return new Parser(tokenize(text)).parse();
}
/** The prefixes an expression names, which a page's resolver is asked. */
export function prefixesIn(expr: CompiledXPath): string[] {
  const found = new Set<string>();
  const steps = (list: Step[]): void => {
    for (const s of list) {
      if (s.test.prefix !== undefined) found.add(s.test.prefix);
      s.preds.forEach(walk);
    }
  };
  function walk(e: Expr): void {
    if ('a' in e) walk(e.a);
    if ('b' in e) walk(e.b);
    if (e.t === 'call') e.args.forEach(walk);
    if (e.t === 'filter') e.preds.forEach(walk);
    if (e.t === 'path') {
      if (e.from) walk(e.from);
      steps(e.steps);
    }
  }
  walk(expr);
  return [...found];
}

const isAttr = (n: XNode): n is XAttr => n instanceof XAttr;
const isElement = (n: XNode): n is Element => n instanceof Element;
const isText = (n: XNode): n is Text => n instanceof Text;
const isComment = (n: XNode): n is Comment => n instanceof Comment;
const isPi = (n: XNode): n is ProcessingInstruction =>
  n instanceof ProcessingInstruction && !n.name.startsWith('!');
const childrenOf = (n: XNode): AnyNode[] =>
  !isAttr(n) && 'children' in n ? (n as ParentNode).children : [];
const parentOf = (n: XNode): AnyNode | null =>
  isAttr(n) ? n.el : (n.parent as AnyNode | null);
const local = (name: string): string => name.slice(name.indexOf(':') + 1);
const asciiLower = (text: string): string =>
  text.replace(/[A-Z]/g, (c) => c.toLowerCase());
/** An element's namespace: what it was made in, or where it stands, as the
 *  HTML parser keeps none. */
export function namespaceOf(el: Element): string {
  if (el.namespace !== undefined) return el.namespace;
  for (let at: AnyNode | null = el; at instanceof Element; at = at.parent) {
    if (at.name.toLowerCase() === 'svg') return SVG_NS;
    if (at.name.toLowerCase() === 'foreignobject' && at !== el) break;
  }
  return HTML_NS;
}
/** An attribute's namespace, by the declarations around its element. */
function attrNamespace(attr: XAttr): string {
  const colon = attr.name.indexOf(':');
  if (colon < 0) return '';
  return namespaceFor(attr.el, attr.name.slice(0, colon)) ?? '';
}
export function namespaceFor(el: AnyNode, prefix: string): string | null {
  if (prefix === 'xml') return 'http://www.w3.org/XML/1998/namespace';
  if (prefix === 'xmlns') return 'http://www.w3.org/2000/xmlns/';
  for (let at: AnyNode | null = el; at; at = at.parent) {
    if (!(at instanceof Element)) continue;
    const value = at.attribs[prefix ? `xmlns:${prefix}` : 'xmlns'];
    if (value !== undefined) return value;
    if (prefix && at.name.startsWith(`${prefix}:`)) {
      return at.namespace ?? null;
    }
  }
  return null;
}

/** A node's string value (XPath 1.0, 5). */
function stringOf(n: XNode): string {
  if (isAttr(n)) return n.el.attribs[n.name] ?? '';
  if (isText(n) || isComment(n)) return n.data;
  if (isPi(n)) return n.data;
  let out = '';
  const walk = (at: AnyNode): void => {
    if (isText(at)) out += at.data;
    else for (const kid of childrenOf(at)) walk(kid);
  };
  walk(n);
  return out;
}
function numberOfString(s: string): number {
  const text = s.trim();
  return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ? Number(text) : NaN;
}
function stringOfNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (n === 0) return '0';
  const text = String(n);
  if (!/e/i.test(text)) return text;
  return n.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
}

interface Frame {
  node: XNode;
  position: number;
  size: number;
}
export interface XPathScope {
  /** A prefix's namespace, which the page's resolver answered. */
  namespaces: Record<string, string>;
  /** Whether the document is an HTML one, whose names are compared without
   *  case (DOM Parsing's XPath binding). */
  html: boolean;
  /** The element with an id, for `id()`. */
  byId?(root: AnyNode, id: string): Element | null;
}

/** What `evaluateXPath` runs on. */
class Evaluator {
  private order: Map<AnyNode, number> | null = null;
  private root: AnyNode;
  constructor(
    private readonly scope: XPathScope,
    context: XNode,
  ) {
    let at: AnyNode = isAttr(context) ? context.el : context;
    while (at.parent) at = at.parent;
    this.root = at;
  }
  /** Where a node stands in document order. */
  private place(n: XNode): number {
    if (!this.order) {
      const order = new Map<AnyNode, number>();
      let i = 0;
      const walk = (at: AnyNode): void => {
        order.set(at, (i += 1));
        for (const kid of childrenOf(at)) walk(kid);
      };
      walk(this.root);
      this.order = order;
    }
    if (isAttr(n)) {
      const names = Object.keys(n.el.attribs);
      return (
        (this.order.get(n.el) ?? 0) +
        (names.indexOf(n.name) + 1) / (names.length + 2)
      );
    }
    return this.order.get(n) ?? 0;
  }
  sorted(nodes: XNode[]): XNode[] {
    const seen = new Set<AnyNode>();
    const attrs = new Map<string, XAttr>();
    const out: XNode[] = [];
    for (const n of nodes) {
      if (isAttr(n)) {
        const key = `${this.place(n.el)} ${n.name}`;
        if (attrs.has(key)) continue;
        attrs.set(key, n);
      } else {
        if (seen.has(n)) continue;
        seen.add(n);
      }
      out.push(n);
    }
    return out.sort((a, b) => this.place(a) - this.place(b));
  }
  private axis(name: string, n: XNode): XNode[] {
    const out: XNode[] = [];
    const descend = (at: XNode): void => {
      for (const kid of childrenOf(at)) {
        out.push(kid);
        descend(kid);
      }
    };
    switch (name) {
      case 'self':
        return [n];
      case 'child':
        return childrenOf(n);
      case 'parent': {
        const p = parentOf(n);
        return p ? [p] : [];
      }
      case 'attribute':
        return isElement(n)
          ? Object.keys(n.attribs)
              .filter((k) => k !== 'xmlns' && !k.startsWith('xmlns:'))
              .map((k) => new XAttr(n, k))
          : [];
      case 'namespace':
        return [];
      case 'descendant':
        descend(n);
        return out;
      case 'descendant-or-self':
        out.push(n);
        descend(n);
        return out;
      case 'ancestor':
      case 'ancestor-or-self': {
        if (name === 'ancestor-or-self') out.push(n);
        for (let p = parentOf(n); p; p = parentOf(p)) out.push(p);
        return out;
      }
      case 'following-sibling':
      case 'preceding-sibling': {
        const p = isAttr(n) ? null : parentOf(n);
        if (!p) return [];
        const kids = childrenOf(p);
        const at = kids.indexOf(n as AnyNode);
        return name === 'following-sibling'
          ? kids.slice(at + 1)
          : kids.slice(0, at).reverse();
      }
      case 'following': {
        for (let at: XNode | null = n; at; at = parentOf(at)) {
          if (isAttr(at)) {
            descend(at.el);
            continue;
          }
          const p = parentOf(at);
          if (!p) break;
          const kids = childrenOf(p);
          for (const kid of kids.slice(kids.indexOf(at) + 1)) {
            out.push(kid);
            descend(kid);
          }
        }
        return out;
      }
      case 'preceding': {
        for (let at: XNode | null = n; at; at = parentOf(at)) {
          if (isAttr(at)) continue;
          const p = parentOf(at);
          if (!p) break;
          const kids = childrenOf(p);
          const before = kids.slice(0, kids.indexOf(at)).reverse();
          for (const kid of before) {
            const inner: XNode[] = [kid];
            const save = out.length;
            descend(kid);
            inner.push(...out.splice(save));
            out.push(...inner.reverse());
          }
        }
        return out;
      }
      default:
        return [];
    }
  }
  private matches(test: Test, axis: string, n: XNode): boolean {
    switch (test.kind) {
      case 'node':
        return true;
      case 'text':
        return isText(n);
      case 'comment':
        return isComment(n);
      case 'pi':
        return (
          isPi(n) &&
          (test.target === undefined || n.name.slice(1) === test.target)
        );
      default:
    }
    const principal = axis === 'attribute' ? isAttr(n) : isElement(n);
    if (!principal) return false;
    if (test.kind === 'any') return true;
    const ns = isAttr(n) ? attrNamespace(n) : namespaceOf(n as Element);
    const name = isAttr(n) ? n.name : (n as Element).name;
    if (test.kind === 'prefix') {
      return ns === this.namespace(test.prefix!);
    }
    const wanted = test.prefix === undefined ? '' : this.namespace(test.prefix);
    // what is HTML's in an HTML document has no case, an attribute of it
    // among them (DOM 8, "XPath 1.0 and HTML"), and only an ASCII letter
    const html =
      this.scope.html &&
      (isAttr(n) ? namespaceOf(n.el) === HTML_NS && ns === '' : ns === HTML_NS);
    if (test.prefix === undefined) {
      if (!html && ns !== '') return false;
    } else if (ns !== wanted) return false;
    return html
      ? asciiLower(local(name)) === asciiLower(test.local!)
      : local(name) === test.local;
  }
  private namespace(prefix: string): string {
    return this.scope.namespaces[prefix] ?? '';
  }
  private filter(nodes: XNode[], preds: Expr[]): XNode[] {
    let list = nodes;
    for (const pred of preds) {
      const size = list.length;
      list = list.filter((node, i) => {
        const v = this.eval(pred, { node, position: i + 1, size });
        return typeof v === 'number' ? v === i + 1 : this.boolean(v);
      });
    }
    return list;
  }
  private steps(start: XNode[], steps: Step[]): XNode[] {
    let nodes = start;
    for (const step of steps) {
      const next: XNode[] = [];
      for (const node of nodes) {
        const candidates = this.axis(step.axis, node).filter((n) =>
          this.matches(step.test, step.axis, n),
        );
        next.push(...this.filter(candidates, step.preds));
      }
      nodes = this.sorted(next);
    }
    return nodes;
  }
  private boolean(v: XValue): boolean {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
    if (typeof v === 'string') return v.length > 0;
    return v;
  }
  private number(v: XValue): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return numberOfString(this.string(v));
  }
  private string(v: XValue): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return stringOfNumber(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return v.length ? stringOf(this.sorted(v)[0]) : '';
  }
  private compare(op: string, a: XValue, b: XValue): boolean {
    const test = (x: number | string | boolean, y: typeof x): boolean => {
      if (op === '=' || op === '!=') {
        const equal =
          typeof x === 'boolean' || typeof y === 'boolean'
            ? this.boolean(x) === this.boolean(y)
            : typeof x === 'number' || typeof y === 'number'
              ? this.number(x) === this.number(y)
              : x === y;
        return op === '=' ? equal : !equal;
      }
      const l = this.number(x);
      const r = this.number(y);
      if (op === '<') return l < r;
      if (op === '<=') return l <= r;
      return op === '>' ? l > r : l >= r;
    };
    if (Array.isArray(a) && Array.isArray(b)) {
      const right = b.map(stringOf);
      return a.some((n) => right.some((s) => test(stringOf(n), s)));
    }
    if (Array.isArray(a)) {
      return typeof b === 'boolean'
        ? test(this.boolean(a), b)
        : a.some((n) => test(stringOf(n), b as string | number));
    }
    if (Array.isArray(b)) {
      return typeof a === 'boolean'
        ? test(a, this.boolean(b))
        : b.some((n) => test(a, stringOf(n)));
    }
    return test(a, b);
  }
  eval(e: Expr, f: Frame): XValue {
    switch (e.t) {
      case 'num':
      case 'str':
        return e.v;
      case 'var':
        throw new XPathSyntaxError(`No variable ${e.name}.`);
      case 'or':
        return (
          this.boolean(this.eval(e.a, f)) || this.boolean(this.eval(e.b, f))
        );
      case 'and':
        return (
          this.boolean(this.eval(e.a, f)) && this.boolean(this.eval(e.b, f))
        );
      case 'cmp':
        return this.compare(e.op, this.eval(e.a, f), this.eval(e.b, f));
      case 'neg':
        return -this.number(this.eval(e.a, f));
      case 'math': {
        const l = this.number(this.eval(e.a, f));
        const r = this.number(this.eval(e.b, f));
        if (e.op === '+') return l + r;
        if (e.op === '-') return l - r;
        if (e.op === '*') return l * r;
        return e.op === 'div' ? l / r : l % r;
      }
      case 'union': {
        const l = this.eval(e.a, f);
        const r = this.eval(e.b, f);
        if (!Array.isArray(l) || !Array.isArray(r)) {
          throw new TypeError('The operands of | are node-sets.');
        }
        return this.sorted([...l, ...r]);
      }
      case 'filter': {
        const v = this.eval(e.a, f);
        if (!Array.isArray(v)) {
          throw new TypeError('A predicate filters a node-set.');
        }
        return this.filter(this.sorted(v), e.preds);
      }
      case 'path': {
        let start: XNode[];
        if (e.from) {
          const v = this.eval(e.from, f);
          if (!Array.isArray(v)) throw new TypeError('A path starts at nodes.');
          start = this.sorted(v);
        } else if (e.root) {
          start = [this.documentOf(f.node)];
        } else start = [f.node];
        return this.steps(start, e.steps);
      }
      case 'call':
        return this.call(e.name, e.args, f);
    }
  }
  private documentOf(n: XNode): AnyNode {
    let at: AnyNode = isAttr(n) ? n.el : n;
    while (at.parent) at = at.parent;
    return at;
  }
  private call(name: string, args: Expr[], f: Frame): XValue {
    const value = (i: number): XValue => this.eval(args[i], f);
    const str = (i: number): string => this.string(value(i));
    const set = (i: number): XNode[] => {
      const v = value(i);
      if (!Array.isArray(v)) throw new TypeError(`${name} takes a node-set.`);
      return this.sorted(v);
    };
    const need = (lo: number, hi = lo): void => {
      if (args.length < lo || args.length > hi) {
        throw new XPathSyntaxError(`${name} is given the wrong arguments.`);
      }
    };
    const first = (): XNode | null =>
      args.length ? (set(0)[0] ?? null) : f.node;
    switch (name) {
      case 'last':
        need(0);
        return f.size;
      case 'position':
        need(0);
        return f.position;
      case 'count':
        need(1);
        return set(0).length;
      case 'id': {
        need(1);
        const v = value(0);
        const ids = (
          Array.isArray(v) ? v.map(stringOf).join(' ') : this.string(v)
        )
          .split(/\s+/)
          .filter(Boolean);
        const root = this.documentOf(f.node);
        const found = ids
          .map((id) => this.findId(root, id))
          .filter((el): el is Element => el !== null);
        return this.sorted(found);
      }
      case 'local-name': {
        need(0, 1);
        const n = first();
        if (!n || !(isElement(n) || isAttr(n) || isPi(n))) return '';
        if (isPi(n)) return n.name.slice(1);
        const named = local(n.name);
        return this.scope.html && isElement(n) ? named.toLowerCase() : named;
      }
      case 'name': {
        need(0, 1);
        const n = first();
        if (!n || !(isElement(n) || isAttr(n) || isPi(n))) return '';
        if (isPi(n)) return n.name.slice(1);
        return this.scope.html && isElement(n) ? n.name.toLowerCase() : n.name;
      }
      case 'namespace-uri': {
        need(0, 1);
        const n = first();
        if (!n) return '';
        if (isAttr(n)) return attrNamespace(n);
        return isElement(n) ? namespaceOf(n) : '';
      }
      case 'string':
        need(0, 1);
        return args.length ? str(0) : stringOf(f.node);
      case 'concat':
        if (args.length < 2) throw new XPathSyntaxError('concat takes two.');
        return args.map((_, i) => str(i)).join('');
      case 'starts-with':
        need(2);
        return str(0).startsWith(str(1));
      case 'contains':
        need(2);
        return str(0).includes(str(1));
      case 'substring-before': {
        need(2);
        const s = str(0);
        const at = s.indexOf(str(1));
        return at < 0 ? '' : s.slice(0, at);
      }
      case 'substring-after': {
        need(2);
        const s = str(0);
        const of = str(1);
        const at = s.indexOf(of);
        return at < 0 ? '' : s.slice(at + of.length);
      }
      case 'substring': {
        need(2, 3);
        const chars = [...str(0)];
        const round = (n: number): number =>
          Number.isFinite(n) ? Math.floor(n + 0.5) : n;
        const start = round(this.number(value(1)));
        const end =
          args.length > 2 ? start + round(this.number(value(2))) : Infinity;
        return chars.filter((_, i) => i + 1 >= start && i + 1 < end).join('');
      }
      case 'string-length':
        need(0, 1);
        return [...(args.length ? str(0) : stringOf(f.node))].length;
      case 'normalize-space':
        need(0, 1);
        return (args.length ? str(0) : stringOf(f.node))
          .replace(/[ \t\r\n]+/g, ' ')
          .replace(/^ | $/g, '');
      case 'translate': {
        need(3);
        const from = [...str(1)];
        const to = [...str(2)];
        return [...str(0)]
          .map((c) => {
            const at = from.indexOf(c);
            return at < 0 ? c : (to[at] ?? '');
          })
          .join('');
      }
      case 'boolean':
        need(1);
        return this.boolean(value(0));
      case 'not':
        need(1);
        return !this.boolean(value(0));
      case 'true':
        need(0);
        return true;
      case 'false':
        need(0);
        return false;
      case 'lang': {
        need(1);
        const wanted = asciiLower(str(0));
        for (let at: XNode | null = f.node; at; at = parentOf(at)) {
          if (!isElement(at)) continue;
          const lang = at.attribs['xml:lang'] ?? at.attribs.lang;
          if (lang === undefined) continue;
          const own = asciiLower(lang);
          return own === wanted || own.startsWith(`${wanted}-`);
        }
        return false;
      }
      case 'number':
        need(0, 1);
        return args.length
          ? this.number(value(0))
          : numberOfString(stringOf(f.node));
      case 'sum': {
        need(1);
        let total = 0;
        for (const n of set(0)) total += numberOfString(stringOf(n));
        return total;
      }
      case 'floor':
        need(1);
        return Math.floor(this.number(value(0)));
      case 'ceiling':
        need(1);
        return Math.ceil(this.number(value(0)));
      case 'round': {
        need(1);
        const n = this.number(value(0));
        return Number.isFinite(n) ? Math.floor(n + 0.5) : n;
      }
      default:
        throw new XPathSyntaxError(`No function ${name}.`);
    }
  }
  private findId(root: AnyNode, id: string): Element | null {
    if (isElement(root) && root.attribs.id === id) return root;
    for (const kid of childrenOf(root)) {
      const found = this.findId(kid, id);
      if (found) return found;
    }
    return null;
  }
  /** An expression's value at a node. */
  run(expr: Expr, node: XNode): XValue {
    const out = this.eval(expr, { node, position: 1, size: 1 });
    return Array.isArray(out) ? this.sorted(out) : out;
  }
}

export function evaluateXPath(
  expr: CompiledXPath,
  context: XNode,
  scope: XPathScope,
): XValue {
  return new Evaluator(scope, context).run(expr, context);
}
