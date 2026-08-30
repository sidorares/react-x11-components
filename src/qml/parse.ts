// QML document → IR. Zero dependencies.
//
// This does not parse the JavaScript inside bindings — it finds where each
// expression ends (bracket depth + string/comment awareness + a
// QML-flavoured newline rule) and hands the source text to the runtime,
// which compiles it with `new Function`. That split is what keeps this
// small: QML's object grammar is tiny; JavaScript is the part we refuse to
// re-implement.
//
// Known, accepted holes (docs/components/qml.md, "the parser"): regex
// literals containing brackets or quotes, and a ternary branch that lands a
// bare `identifier :` at the start of a line. Real QML corpus hits neither.

import type {
  AliasTargetIR,
  BindingMemberIR,
  MemberIR,
  ObjectIR,
  QmlDocument,
  QmlImport,
  ValueIR,
} from './ir.js';

const KEYWORDS = new Set([
  'import',
  'pragma',
  'property',
  'signal',
  'function',
  'readonly',
  'default',
  'required',
  'component',
  'enum',
  'on',
  'as',
]);

export class ParseError extends Error {
  line: number;
  col: number;
  constructor(message: string, source: string, pos: number) {
    const { line, col } = lineCol(source, pos);
    super(`QML parse error at ${line}:${col}: ${message}`);
    this.line = line;
    this.col = col;
  }
}

function lineCol(source: string, pos: number): { line: number; col: number } {
  let line = 1;
  let last = 0;
  for (let i = 0; i < pos && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      last = i + 1;
    }
  }
  return { line, col: pos - last + 1 };
}

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdChar = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isUpper = (c: string) => c >= 'A' && c <= 'Z';

class Scanner {
  source: string;
  pos = 0;

  constructor(source: string) {
    this.source = source;
  }

  error(message: string, pos = this.pos): ParseError {
    return new ParseError(message, this.source, pos);
  }

  atEnd(): boolean {
    return this.pos >= this.source.length;
  }

  /** Skip whitespace and comments. Returns true if a newline was crossed. */
  skipTrivia(): boolean {
    const src = this.source;
    let newline = false;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '\n') {
        newline = true;
        this.pos++;
      } else if (c === ' ' || c === '\t' || c === '\r') {
        this.pos++;
      } else if (c === '/' && src[this.pos + 1] === '/') {
        while (this.pos < src.length && src[this.pos] !== '\n') this.pos++;
      } else if (c === '/' && src[this.pos + 1] === '*') {
        const end = src.indexOf('*/', this.pos + 2);
        if (end === -1) throw this.error('unterminated comment');
        if (src.slice(this.pos, end).includes('\n')) newline = true;
        this.pos = end + 2;
      } else {
        break;
      }
    }
    return newline;
  }

  peekChar(): string | undefined {
    const save = this.pos;
    this.skipTrivia();
    const c = this.source[this.pos];
    this.pos = save;
    return c;
  }

  /** The identifier at the next token position, or null. Does not consume. */
  peekIdent(): string | null {
    const save = this.pos;
    this.skipTrivia();
    const id = this.tryIdent();
    this.pos = save;
    return id;
  }

  tryIdent(): string | null {
    if (this.atEnd() || !isIdStart(this.source[this.pos])) return null;
    const start = this.pos;
    while (this.pos < this.source.length && isIdChar(this.source[this.pos]))
      this.pos++;
    return this.source.slice(start, this.pos);
  }

  expectIdent(what = 'identifier'): string {
    this.skipTrivia();
    const id = this.tryIdent();
    if (!id) throw this.error(`expected ${what}`);
    return id;
  }

  tryPunct(p: string): boolean {
    const save = this.pos;
    this.skipTrivia();
    if (this.source.startsWith(p, this.pos)) {
      this.pos += p.length;
      return true;
    }
    this.pos = save;
    return false;
  }

  expectPunct(p: string): void {
    if (!this.tryPunct(p)) throw this.error(`expected '${p}'`);
  }

  /** A dotted name: `anchors.fill`, `Component.onCompleted`. */
  dottedName(): string[] {
    const parts = [this.expectIdent()];
    while (this.tryPunct('.')) parts.push(this.expectIdent());
    return parts;
  }

  // --- raw-source slurping ---------------------------------------------

  /** Consume a string/template literal (opening quote at `pos`). */
  skipString(): void {
    const src = this.source;
    const quote = src[this.pos];
    this.pos++;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '\\') {
        this.pos += 2;
        continue;
      }
      if (c === quote) {
        this.pos++;
        return;
      }
      if (quote === '`' && c === '$' && src[this.pos + 1] === '{') {
        this.pos += 2;
        this.skipBalancedUntil('}');
        continue;
      }
      this.pos++;
    }
    throw this.error('unterminated string');
  }

  /** After an opener was consumed, skip to its closer, tracking nesting. */
  skipBalancedUntil(closer: string): void {
    const openers: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    const depthFor: Record<string, number> = { '(': 0, '[': 0, '{': 0 };
    const src = this.source;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '"' || c === "'" || c === '`') {
        this.skipString();
        continue;
      }
      if (
        c === '/' &&
        (src[this.pos + 1] === '/' || src[this.pos + 1] === '*')
      ) {
        this.skipTrivia();
        continue;
      }
      if (c === '(' || c === '[' || c === '{') {
        depthFor[c]++;
        this.pos++;
        continue;
      }
      if (c === ')' || c === ']' || c === '}') {
        const open = openers[c];
        if (depthFor[open] === 0) {
          if (c === closer) {
            this.pos++;
            return;
          }
          throw this.error(`unbalanced '${c}'`);
        }
        depthFor[open]--;
        this.pos++;
        continue;
      }
      this.pos++;
    }
    throw this.error(`expected '${closer}'`);
  }

  /** Slurp a balanced `{ … }` block; returns the inner source. */
  slurpBlock(): string {
    this.skipTrivia();
    this.expectPunct('{');
    const start = this.pos;
    this.skipBalancedUntil('}');
    return this.source.slice(start, this.pos - 1);
  }

  /**
   * Slurp a JS expression as raw text. Ends at `;` (consumed), before an
   * unbalanced `}`/`]`, at a depth-0 `,` (when `stopComma`), or at a
   * newline followed by what can only be the next member (QML's ASI).
   */
  slurpExpression({ stopComma = false } = {}): string {
    const src = this.source;
    this.skipTrivia();
    const start = this.pos;
    let depth = 0;
    let lastSig = ''; // last significant char, for the continuation test
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '"' || c === "'" || c === '`') {
        this.skipString();
        lastSig = '"';
        continue;
      }
      if (
        c === '/' &&
        (src[this.pos + 1] === '/' || src[this.pos + 1] === '*')
      ) {
        const crossed = this.skipTrivia();
        if (crossed && depth === 0 && this.expressionEndsHere(lastSig)) break;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') {
        depth++;
        lastSig = c;
        this.pos++;
        continue;
      }
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break; // the parent context's closer
        depth--;
        lastSig = c;
        this.pos++;
        continue;
      }
      if (c === ';' && depth === 0) {
        const end = this.pos;
        this.pos++;
        return src.slice(start, end);
      }
      if (c === ',' && depth === 0 && stopComma) break;
      if (c === '\n') {
        if (depth === 0 && this.expressionEndsHere(lastSig)) break;
        this.pos++;
        continue;
      }
      if (!' \t\r'.includes(c)) lastSig = c;
      this.pos++;
    }
    const text = src.slice(start, this.pos).trim();
    if (!text) throw this.error('expected expression', start);
    return text;
  }

  /**
   * At a depth-0 newline: does the expression end, or continue? It
   * continues when the last char reads as an unfinished operator, or the
   * next line starts with one; it ends when the next tokens look like a
   * member start (`ident… :`, `Type {`, a keyword, or `}`).
   */
  expressionEndsHere(lastSig: string): boolean {
    if ('+-*/%<>=&|^!?:.,([{'.includes(lastSig) || lastSig === '') return false;
    const save = this.pos;
    this.skipTrivia();
    const c = this.source[this.pos];
    if (c === undefined || c === '}' || c === ']') {
      this.pos = save;
      return true;
    }
    if ('+-*/%<>=&|^?:.'.includes(c) || c === ')' || c === ',') {
      this.pos = save;
      return false; // `.method()` chains, operators, ternary arms
    }
    const id = this.tryIdent();
    if (id) {
      if (KEYWORDS.has(id) && id !== 'on' && id !== 'as') {
        this.pos = save;
        return true;
      }
      // `Type {`, `Type on prop {`
      if (isUpper(id[0])) {
        const next = this.peekIdent();
        if (this.peekChar() === '{' || next === 'on') {
          this.pos = save;
          return true;
        }
      }
      // `name:` / `group.sub:` / `group {`
      while (this.tryPunct('.')) {
        if (!this.tryIdent()) break;
      }
      const after = this.peekChar();
      this.pos = save;
      return after === ':' || after === '{';
    }
    this.pos = save;
    return false;
  }
}

// --- grammar ---------------------------------------------------------------

export function parseQml(
  source: string,
  { fileName = '<qml>' }: { fileName?: string } = {},
): QmlDocument {
  const s = new Scanner(source);
  const imports: QmlImport[] = [];
  const pragmas: string[] = [];
  for (;;) {
    const id = s.peekIdent();
    if (id === 'import') {
      s.expectIdent();
      imports.push(parseImport(s));
    } else if (id === 'pragma') {
      s.expectIdent();
      pragmas.push(s.expectIdent('pragma name'));
    } else {
      break;
    }
  }
  const root = parseObject(s);
  s.skipTrivia();
  if (!s.atEnd()) throw s.error('expected end of document after root object');
  return { fileName, imports, pragmas, root };
}

function parseImport(s: Scanner): QmlImport {
  s.skipTrivia();
  const imp: QmlImport = {};
  if (s.source[s.pos] === '"' || s.source[s.pos] === "'") {
    const start = s.pos;
    s.skipString();
    imp.path = s.source.slice(start + 1, s.pos - 1);
  } else {
    imp.module = s.dottedName().join('.');
    s.skipTrivia();
    if (/[0-9]/.test(s.source[s.pos])) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(s.source.slice(s.pos));
      if (m) {
        imp.version = m[0];
        s.pos += m[0].length;
      }
    }
  }
  if (s.peekIdent() === 'as') {
    s.expectIdent();
    imp.alias = s.expectIdent('import alias');
  }
  s.tryPunct(';');
  return imp;
}

function parseObject(s: Scanner): ObjectIR {
  s.skipTrivia();
  const loc = s.pos;
  const type = s.dottedName().join('.');
  if (!isUpper(type[0]))
    throw s.error(`type name must start uppercase: '${type}'`, loc);
  return parseObjectBody(s, type, loc);
}

function parseObjectBody(s: Scanner, type: string, loc: number): ObjectIR {
  s.expectPunct('{');
  const members: MemberIR[] = [];
  const obj: ObjectIR = { type, id: null, members, loc };
  for (;;) {
    s.skipTrivia();
    if (s.tryPunct('}')) return obj;
    if (s.atEnd()) throw s.error('unterminated object body', loc);
    members.push(parseMember(s, obj));
    s.tryPunct(';');
  }
}

// A declaration keyword used as a plain property name — Qt's own Binding
// element has `property: "width"` — is told apart by the colon right after.
function identIsBindingName(s: Scanner): boolean {
  const save = s.pos;
  s.skipTrivia();
  s.tryIdent();
  const colon = s.peekChar() === ':';
  s.pos = save;
  return colon;
}

function parseMember(s: Scanner, obj: ObjectIR): MemberIR {
  const loc = s.pos;
  const kw = s.peekIdent();
  const asBinding = kw !== null && KEYWORDS.has(kw) && identIsBindingName(s);

  if (
    !asBinding &&
    (kw === 'property' ||
      kw === 'readonly' ||
      kw === 'default' ||
      kw === 'required')
  ) {
    return parsePropertyDecl(s, loc);
  }
  if (!asBinding && kw === 'signal') {
    s.expectIdent();
    const name = s.expectIdent('signal name');
    const params: Array<{ type: string; name: string }> = [];
    if (s.tryPunct('(')) {
      while (!s.tryPunct(')')) {
        const a = s.expectIdent('parameter type');
        const b =
          s.peekIdent() && s.peekChar() !== ',' && s.peekChar() !== ')'
            ? s.expectIdent()
            : null;
        params.push(b ? { type: a, name: b } : { type: 'var', name: a });
        if (s.tryPunct(':')) s.expectIdent('parameter type'); // `x: int` style
        s.tryPunct(',');
      }
    }
    return { kind: 'signal', name, params, loc };
  }
  if (!asBinding && kw === 'function') {
    s.expectIdent();
    const name = s.expectIdent('function name');
    s.expectPunct('(');
    const start = s.pos;
    s.skipBalancedUntil(')');
    const params = s.source
      .slice(start, s.pos - 1)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => p.split(':')[0].trim()); // tolerate type annotations
    const body = s.slurpBlock();
    return { kind: 'function', name, params, body, loc };
  }
  if (!asBinding && kw === 'component') {
    // inline component: `component Foo: Item { … }`
    s.expectIdent();
    const name = s.expectIdent('component name');
    s.expectPunct(':');
    const object = parseObject(s);
    return { kind: 'inline-component', name, object, loc };
  }

  // From here: `Type {`, `Type on prop {`, `name: value`, `group { … }`.
  const path = s.dottedName();
  const head = path[0];

  if (isUpper(head[0]) && path.length === 1 && s.peekIdent() === 'on') {
    s.expectIdent(); // 'on'
    const target = s.dottedName();
    const object = parseObjectBody(s, head, loc);
    return { kind: 'value-source', object, on: target, loc };
  }
  if (isUpper(head[0]) && s.peekChar() === '{') {
    const object = parseObjectBody(s, path.join('.'), loc);
    return { kind: 'object', object, loc };
  }
  if (s.tryPunct(':')) {
    if (path.length === 1 && head === 'id') {
      const id = s.expectIdent('id');
      obj.id = id;
      return { kind: 'id', id, loc };
    }
    const value = parseBindingValue(s);
    return { kind: 'binding', path, value, loc };
  }
  if (s.peekChar() === '{' && !isUpper(head[0])) {
    // grouped-property block: `anchors { fill: parent; margins: 4 }`
    s.expectPunct('{');
    const group: BindingMemberIR[] = [];
    for (;;) {
      s.skipTrivia();
      if (s.tryPunct('}')) break;
      const sub = s.dottedName();
      s.expectPunct(':');
      group.push({
        kind: 'binding',
        path: [...path, ...sub],
        value: parseBindingValue(s),
        loc,
      });
      s.tryPunct(';');
    }
    return { kind: 'group', bindings: group, loc };
  }
  throw s.error(`unexpected member '${path.join('.')}'`, loc);
}

function parsePropertyDecl(s: Scanner, loc: number): MemberIR {
  let isReadonly = false;
  let isDefault = false;
  let isRequired = false;
  for (;;) {
    const kw = s.peekIdent();
    if (kw === 'readonly') {
      s.expectIdent();
      isReadonly = true;
    } else if (kw === 'default') {
      s.expectIdent();
      isDefault = true;
    } else if (kw === 'required') {
      s.expectIdent();
      isRequired = true;
    } else break;
  }
  const kw = s.expectIdent();
  if (kw !== 'property') throw s.error(`expected 'property', got '${kw}'`, loc);
  let propType = s.expectIdent('property type');
  if (propType === 'list') {
    s.expectPunct('<');
    s.dottedName();
    s.expectPunct('>');
    propType = 'list';
  }
  const name = s.expectIdent('property name');
  let value: ValueIR | AliasTargetIR | null = null;
  if (s.tryPunct(':')) {
    value =
      propType === 'alias'
        ? { kind: 'alias-target', path: s.dottedName() }
        : parseBindingValue(s);
  }
  return {
    kind: 'property',
    name,
    propType,
    readonly: isReadonly,
    default: isDefault,
    required: isRequired,
    value,
    loc,
  };
}

function parseBindingValue(s: Scanner, { stopComma = false } = {}): ValueIR {
  s.skipTrivia();
  const c = s.source[s.pos];
  if (c === '[') {
    // Array of objects (`states: [State { … }, …]`) or a JS array
    // expression; objects win when the first element looks like `Type {`.
    const save = s.pos;
    s.expectPunct('[');
    const first = s.peekIdent();
    if (first && isUpper(first[0])) {
      const inner = s.pos;
      s.skipTrivia();
      s.tryIdent();
      while (s.tryPunct('.')) s.tryIdent();
      const isObj = s.peekChar() === '{';
      s.pos = inner;
      if (isObj) {
        const items: ValueIR[] = [];
        for (;;) {
          s.skipTrivia();
          if (s.tryPunct(']')) break;
          items.push({ kind: 'object', object: parseObject(s) });
          s.tryPunct(',');
        }
        return { kind: 'array', items };
      }
    }
    s.pos = save;
    const loc = s.pos;
    return { kind: 'expr', src: s.slurpExpression({ stopComma }), loc };
  }
  if (c === '{') {
    // QML rule: a brace after ':' is a statement block, not an object
    // literal (and the block is still a reactive binding).
    const loc = s.pos;
    return { kind: 'block', src: s.slurpBlock(), loc };
  }
  const id = s.peekIdent();
  if (id && isUpper(id[0])) {
    const save = s.pos;
    s.skipTrivia();
    s.tryIdent();
    while (s.tryPunct('.')) s.tryIdent();
    const isObj = s.peekChar() === '{';
    s.pos = save;
    if (isObj) return { kind: 'object', object: parseObject(s) };
  }
  const loc = s.pos;
  return { kind: 'expr', src: s.slurpExpression({ stopComma }), loc };
}
