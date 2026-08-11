// JavaScript / TypeScript / JSX, as a stream mode — for the mini-IDE use
// case.
//
// This is the language where a hand tokenizer earns an honesty note: it
// handles strings, template literals with nested `${}`, comments, numeric
// literals, the regex-versus-division ambiguity (by tracking what the last
// significant token was, the way CodeMirror 5's mode did), keywords,
// property/call positions, and — with `{ jsx: true }` — JSX elements:
// tags, attributes, `{…}` expression containers nesting full JavaScript,
// children text, fragments. The known losses are the ambiguous corners the
// grammar itself makes hard for a line tokenizer: `a = b\n/c/g` regexes,
// and TSX arrow generics (`<T,>(x) => …` reads as a tag until the comma).
// Apps that want the real thing plug `@lezer/javascript` in through
// `lezerLanguage()` — same editor, same theme, a real incremental parser.
import { streamLanguage } from '../stream.js';
import type { StringStream } from '../stream.js';
import type { Language } from '../types.js';

const KEYWORDS = new Set(
  (
    'async await break case catch class const continue debugger default ' +
    'delete do else export extends finally for from function get if import ' +
    'in instanceof let new of return set static switch throw try typeof var ' +
    'void while with yield'
  ).split(' '),
);

const TS_KEYWORDS = new Set(
  (
    'abstract any as asserts boolean declare enum implements infer interface ' +
    'is keyof namespace never number object out override private protected ' +
    'public readonly satisfies string symbol type undefined unique unknown'
  ).split(' '),
);

const ATOMS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
]);
const SELF = new Set(['this', 'super', 'globalThis']);

/**
 * The mode's cross-line state, flat so the engine's default copy/equals
 * apply:
 * - `ctx` is a stack encoded as a string. `C`/`D` block/doc comment, `T`
 *   template literal, `B` a `${…}` interpolation, `{` a plain brace inside
 *   one; and, with JSX on: `N` an opening tag before its name, `A` its
 *   attribute zone, `M` a closing tag before its name, `K` a closing tag
 *   awaiting `>`, `E` element children, `J` a `{…}` expression container.
 * - `str` is `'`/`"` while a string continues across a `\` line break.
 * - `value` is true when the previous significant token produced a value —
 *   which is exactly the bit that disambiguates `/` (divide after a value,
 *   regex otherwise) and `<` (compare after a value, JSX otherwise).
 */
interface JsState {
  ctx: string;
  str: string;
  value: boolean;
}

function top(state: JsState): string {
  return state.ctx.charAt(state.ctx.length - 1);
}

function pop(state: JsState): void {
  state.ctx = state.ctx.slice(0, -1);
}

/** `<` (or `</`) seen where a tag may start. */
function enterTag(stream: StringStream, state: JsState): string {
  stream.next();
  state.ctx += stream.eat('/') ? 'M' : 'N';
  return 'punctuation';
}

/** The element finished (`/>`, or `</…>`): a JSX element is a value. */
function elementClosed(state: JsState): void {
  state.value = true;
}

/** Inside a tag: name, attributes, expression containers, and the close. */
function tagToken(stream: StringStream, state: JsState): string | null {
  if (stream.eatSpace()) return null;
  let t = top(state);

  // the tag name comes first; a fragment (`<>`/`</>`) has none
  if (t === 'N' || t === 'M') {
    if (stream.match(/^[A-Za-z_$][\w.$-]*/)) {
      state.ctx = state.ctx.slice(0, -1) + (t === 'N' ? 'A' : 'K');
      const name = stream.current();
      // lowercase simple names are host elements; anything else a component
      return /^[a-z][\w-]*$/.test(name) ? 'typeName' : 'className';
    }
    state.ctx = state.ctx.slice(0, -1) + (t === 'N' ? 'A' : 'K');
    t = top(state);
  }

  if (t === 'K') {
    if (stream.eat('>')) {
      pop(state); // the closing tag
      if (top(state) === 'E') pop(state); // …ends its element
      elementClosed(state);
      return 'punctuation';
    }
    stream.next();
    return null;
  }

  // t === 'A': the attribute zone
  const ch = stream.peek();
  if (stream.match('/>')) {
    pop(state);
    elementClosed(state);
    return 'punctuation';
  }
  if (ch === '>') {
    stream.next();
    pop(state);
    state.ctx += 'E';
    return 'punctuation';
  }
  if (ch === '{') {
    stream.next();
    state.ctx += 'J';
    state.value = false;
    return 'punctuation';
  }
  if (ch === '"' || ch === "'") {
    stream.next();
    while (!stream.eol() && !stream.eat(ch)) stream.next();
    return 'string';
  }
  if (stream.eat('=')) return 'operator';
  if (stream.match(/^[A-Za-z_][\w:-]*/)) return 'propertyName';
  stream.next();
  return null;
}

/** Between tags: children text, `{…}` expressions, nested tags. */
function childrenToken(stream: StringStream, state: JsState): string | null {
  const ch = stream.peek();
  if (ch === '<') return enterTag(stream, state);
  if (ch === '{') {
    stream.next();
    state.ctx += 'J';
    state.value = false;
    return 'punctuation';
  }
  while (!stream.eol()) {
    const next = stream.peek();
    if (next === '<' || next === '{') break;
    stream.next();
  }
  return null; // children text paints plain
}

function eatEscape(stream: StringStream): boolean {
  return (
    stream.match(
      /^\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)?/,
    ) !== null
  );
}

/** Consume string content up to the closing quote / EOL. Returns the type,
 * updating `state.str` when a trailing `\` continues the string. */
function stringToken(
  stream: StringStream,
  state: JsState,
  quote: string,
): string {
  state.str = '';
  while (!stream.eol()) {
    if (stream.peek() === '\\') {
      if (stream.match(/^\\$/)) {
        state.str = quote; // continues on the next line
        return 'string';
      }
      eatEscape(stream);
      continue;
    }
    if (stream.eat(quote)) return 'string';
    stream.next();
  }
  return 'string'; // unterminated: paint, do not carry over
}

/** Inside a template literal: content, `${` and the closing backtick. */
function templateToken(stream: StringStream, state: JsState): string {
  while (!stream.eol()) {
    if (stream.peek() === '\\') {
      eatEscape(stream);
      continue;
    }
    if (stream.match('${')) {
      if (stream.pos - stream.start > 2) {
        stream.backUp(2); // emit the content run first
        return 'string2';
      }
      state.ctx += 'B';
      state.value = false;
      return 'punctuation';
    }
    if (stream.eat('`')) {
      if (stream.pos - stream.start > 1) {
        stream.backUp(1);
        return 'string2';
      }
      state.ctx = state.ctx.slice(0, -1);
      state.value = true;
      return 'string2';
    }
    stream.next();
  }
  return 'string2';
}

function makeToken(typescript: boolean, jsx: boolean) {
  return function token(stream: StringStream, state: JsState): string | null {
    if (top(state) === 'C' || top(state) === 'D') {
      const doc = top(state) === 'D';
      if (stream.match(/^.*?\*\//)) state.ctx = state.ctx.slice(0, -1);
      else stream.skipToEnd();
      return doc ? 'docComment' : 'comment';
    }
    if (state.str) {
      const quote = state.str;
      return stringToken(stream, state, quote);
    }
    if (top(state) === 'T') return templateToken(stream, state);
    const jsxCtx = top(state);
    if (jsxCtx === 'N' || jsxCtx === 'M' || jsxCtx === 'A' || jsxCtx === 'K') {
      return tagToken(stream, state);
    }
    if (jsxCtx === 'E') return childrenToken(stream, state);

    if (stream.eatSpace()) return null;

    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      const doc = stream.match('*', false) !== null;
      if (!stream.match(/^.*?\*\//)) {
        state.ctx += doc ? 'D' : 'C';
        stream.skipToEnd();
      }
      return doc ? 'docComment' : 'comment';
    }

    const ch = stream.peek();

    if (ch === "'" || ch === '"') {
      stream.next();
      state.value = true;
      return stringToken(stream, state, ch);
    }
    if (ch === '`') {
      stream.next();
      state.ctx += 'T';
      return templateToken(stream, state);
    }

    if (ch === '/') {
      if (!state.value) {
        // regex position — consume /pattern/flags with classes and escapes
        if (
          stream.match(/^\/(?:[^/\\[\n]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[a-z]*/)
        ) {
          state.value = true;
          return 'string2';
        }
      }
      stream.next();
      stream.eat('=');
      state.value = false;
      return 'operator';
    }

    if (
      stream.match(/^0[xX][0-9a-fA-F_]+n?/) ||
      stream.match(/^0[bB][01_]+n?/) ||
      stream.match(/^0[oO][0-7_]+n?/) ||
      stream.match(/^\d[\d_]*(\.[\d_]*)?([eE][+-]?\d+)?n?/) ||
      stream.match(/^\.\d[\d_]*([eE][+-]?\d+)?/)
    ) {
      state.value = true;
      return 'number';
    }

    if (
      jsx &&
      ch === '<' &&
      !state.value &&
      /[A-Za-z_$/>]/.test(stream.string.charAt(stream.pos + 1))
    ) {
      return enterTag(stream, state);
    }

    if (stream.match(/^[$A-Za-z_][$\w]*/)) {
      const word = stream.current();
      if (KEYWORDS.has(word) || (typescript && TS_KEYWORDS.has(word))) {
        // `typeof x` is not a value; `this` is — handled below via SELF
        state.value = false;
        return 'keyword';
      }
      if (ATOMS.has(word)) {
        state.value = true;
        return 'atom';
      }
      if (SELF.has(word)) {
        state.value = true;
        return 'self';
      }
      state.value = true;
      if (stream.match(/^\s*\(/, false)) return 'function';
      return 'variableName';
    }

    if (ch === '.' || stream.match('?.', false)) {
      if (ch === '.') stream.next();
      else stream.match('?.');
      if (stream.match(/^[$A-Za-z_][$\w]*/)) {
        state.value = true;
        // a call right after the dot is a method
        return stream.match(/^\s*\(/, false) ? 'function' : 'propertyName';
      }
      state.value = false;
      return 'punctuation';
    }

    if (ch === '{') {
      stream.next();
      const t = top(state);
      if (t === 'B' || t === 'J' || t === '{') state.ctx += '{';
      state.value = false;
      return 'bracket';
    }
    if (ch === '}') {
      stream.next();
      const t = top(state);
      if (t === '{') {
        state.ctx = state.ctx.slice(0, -1);
        state.value = false;
        return 'bracket';
      }
      if (t === 'B') {
        state.ctx = state.ctx.slice(0, -1); // back into the template
        return 'punctuation';
      }
      if (t === 'J') {
        state.ctx = state.ctx.slice(0, -1); // back into the tag or children
        return 'punctuation';
      }
      state.value = false;
      return 'bracket';
    }
    if (ch === ')' || ch === ']') {
      stream.next();
      state.value = true; // `(a + b) / 2` divides
      return 'bracket';
    }
    if (ch === '(' || ch === '[') {
      stream.next();
      state.value = false;
      return 'bracket';
    }
    if (stream.eat(/[;,]/)) {
      state.value = false;
      return 'punctuation';
    }
    if (stream.eatWhile(/[+\-*%<>=!&|^~?:]/)) {
      state.value = false;
      return 'operator';
    }
    stream.next();
    state.value = false;
    return null;
  };
}

export interface JavascriptOptions {
  /** Also recognise TypeScript's keywords. */
  typescript?: boolean;
  /** Also tokenize JSX elements. */
  jsx?: boolean;
}

/** JavaScript — or TypeScript, JSX and TSX, by options. */
export function javascript(options: JavascriptOptions = {}): Language {
  const typescript = options.typescript ?? false;
  const jsx = options.jsx ?? false;
  return streamLanguage<JsState>({
    name: typescript
      ? jsx
        ? 'tsx'
        : 'typescript'
      : jsx
        ? 'jsx'
        : 'javascript',
    languageData: {
      lineComment: '//',
      wordChars: '$',
      completions: [
        ...KEYWORDS,
        ...(typescript ? TS_KEYWORDS : []),
        ...ATOMS,
      ].sort(),
      indentAfter: /[([{]\s*$/,
    },
    startState: () => ({ ctx: '', str: '', value: false }),
    token: makeToken(typescript, jsx),
  });
}
