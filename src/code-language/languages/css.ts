// CSS, as a stream mode: a style sheet as its reader sees it — selectors
// and the classes, ids and pseudo-classes in them, at-rules, property
// names, custom properties, and values with their numbers, colours,
// functions and `!important`.
//
// The one piece of state that makes CSS look right is where the line is:
// in a selector, in a block's declarations, or in a declaration's value
// after its colon. Nesting makes "in a block" ambiguous — `&:hover {` and
// `color: red;` both start with a word and a colon — so a run inside a
// block that reaches a `{` before a `;` is read as a selector, the rule
// CSS Nesting's own parser follows.
import { streamLanguage } from '../stream.js';
import type { StringStream } from '../stream.js';
import type { Language } from '../types.js';

interface CssState {
  /** How many blocks deep: 0 is the sheet's top. */
  depth: number;
  /** Inside a comment that has not ended. */
  comment: boolean;
  /** After a declaration's colon, until its `;` or the block's end. */
  value: boolean;
  /** In a run inside a block that is a nested rule's selector. */
  selector: boolean;
  /** In an at-rule's prelude, until its `{` or `;`. */
  prelude: boolean;
}

const IDENT = /^-?[_a-zA-Z -￿\\][-_a-zA-Z0-9 -￿\\]*/;

function comment(stream: StringStream, state: CssState): string {
  while (!stream.eol()) {
    if (stream.match('*/')) {
      state.comment = false;
      return 'comment';
    }
    stream.next();
  }
  return 'comment';
}

function quoted(stream: StringStream, quote: string): string {
  while (!stream.eol()) {
    const ch = stream.next();
    if (ch === '\\') stream.next();
    else if (ch === quote) break;
  }
  return 'string';
}

function token(stream: StringStream, state: CssState): string | null {
  if (state.comment) return comment(stream, state);
  if (stream.eatSpace()) return null;
  if (stream.match('/*')) {
    state.comment = true;
    return comment(stream, state);
  }
  const ch = stream.peek()!;
  if (ch === '"' || ch === "'") {
    stream.next();
    return quoted(stream, ch);
  }
  if (ch === '{') {
    stream.next();
    state.depth += 1;
    state.value = false;
    state.selector = false;
    state.prelude = false;
    return 'bracket';
  }
  if (ch === '}') {
    stream.next();
    state.depth = Math.max(0, state.depth - 1);
    state.value = false;
    state.selector = false;
    return 'bracket';
  }
  if (ch === ';') {
    stream.next();
    state.value = false;
    state.prelude = false;
    return 'punctuation';
  }
  if (ch === '@' && stream.match(/^@[-\w]+/)) {
    state.prelude = true;
    return 'keyword';
  }

  const declarations = state.depth > 0 && !state.prelude && !state.selector;
  // the start of a run in a block: a declaration, or a nested rule's
  // selector where a `{` comes before a `;`
  if (declarations && !state.value && stream.match(/^[^;{}]*\{/, false)) {
    state.selector = true;
  }
  const inSelector =
    !state.prelude && (state.depth === 0 || state.selector) && !state.value;

  if (state.value || state.prelude) return value(stream, state);
  if (inSelector) return selector(stream);

  // a declaration's name, and its colon
  if (stream.match(/^--[-\w]*/)) return 'variableName';
  if (stream.match(IDENT)) return 'propertyName';
  if (ch === ':') {
    stream.next();
    state.value = true;
    return 'punctuation';
  }
  stream.next();
  return null;
}

function selector(stream: StringStream): string | null {
  const ch = stream.peek()!;
  if (ch === '.' && stream.match(/^\.(?:[-\w\u00a0-\uffff]|\\.)+/)) {
    // an escaped colon is the name's, `.md\:flex`; a bare one a pseudo-class
    return 'className';
  }
  if (ch === '#' && stream.match(/^#(?:[-\w\u00a0-\uffff]|\\.)+/))
    return 'atom';
  if (ch === ':' && stream.match(/^::?[-\w]+/)) return 'meta';
  if (ch === '[') {
    stream.next();
    stream.match(/^[^\]]*/);
    stream.eat(']');
    return 'propertyName';
  }
  if (ch === '&' || ch === '*') {
    stream.next();
    return 'keyword';
  }
  if (stream.match(IDENT)) return 'typeName';
  stream.next();
  return /[>+~,()]/.test(ch) ? 'operator' : null;
}

function value(stream: StringStream, state: CssState): string | null {
  const ch = stream.peek()!;
  if (ch === '!' && stream.match(/^!\s*important\b/i)) return 'keyword';
  if (ch === '#' && stream.match(/^#[0-9a-fA-F]{3,8}\b/)) return 'number';
  if (stream.match(/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i)) {
    stream.match(/^(%|[a-zA-Z]+)/);
    return 'number';
  }
  if (stream.match(/^--[-\w]*/)) return 'variableName';
  if (stream.match(/^url\(/i, false)) {
    stream.match(/^url\(/i);
    if (!stream.match(/^\s*["']/, false)) {
      stream.match(/^[^)]*/);
    }
    return 'function';
  }
  if (stream.match(/^-?[_a-zA-Z][-\w]*(?=\()/)) return 'function';
  if (stream.match(IDENT)) return state.prelude ? 'propertyName' : 'atom';
  stream.next();
  return /[,/()]/.test(ch) ? 'punctuation' : ch === ':' ? 'punctuation' : null;
}

function build(): Language {
  return streamLanguage<CssState>({
    name: 'css',
    languageData: { indentAfter: /\{\s*$/, wordChars: '-' },
    startState: () => ({
      depth: 0,
      comment: false,
      value: false,
      selector: false,
      prelude: false,
    }),
    token,
  });
}

// One Language, made the first time it is asked for, as every built-in's:
// a new one is a new tokenizer, and every line in view laid out again.
let made: Language | undefined;

/** CSS, nesting and custom properties included. */
export function css(): Language {
  return (made ??= build());
}
