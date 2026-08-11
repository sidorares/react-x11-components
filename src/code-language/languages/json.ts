// JSON, as a stream mode. Tiny, but it earns its file: config editing is a
// real input-field use case, and "is this string a key or a value" is the
// one piece of state that makes JSON look right.
import { streamLanguage } from '../stream.js';
import type { StringStream } from '../stream.js';
import type { Language } from '../types.js';

interface JsonState {
  /** Stack of `{`/`[`, encoded as a string. */
  ctx: string;
  /** Inside `{…}` and before a `:` — the next string is a key. */
  expectKey: boolean;
}

function token(stream: StringStream, state: JsonState): string | null {
  if (stream.eatSpace()) return null;
  const ch = stream.peek();

  if (ch === '"') {
    stream.next();
    while (!stream.eol()) {
      if (stream.match(/^\\./)) continue;
      if (stream.eat('"')) break;
      stream.next();
    }
    const key = state.expectKey && stream.match(/^\s*:/, false) !== null;
    if (key) state.expectKey = false;
    return key ? 'propertyName' : 'string';
  }
  if (ch === '{') {
    stream.next();
    state.ctx += '{';
    state.expectKey = true;
    return 'bracket';
  }
  if (ch === '[') {
    stream.next();
    state.ctx += '[';
    state.expectKey = false;
    return 'bracket';
  }
  if (ch === '}' || ch === ']') {
    stream.next();
    state.ctx = state.ctx.slice(0, -1);
    state.expectKey = false;
    return 'bracket';
  }
  if (ch === ',') {
    stream.next();
    state.expectKey = state.ctx.endsWith('{');
    return 'punctuation';
  }
  if (ch === ':') {
    stream.next();
    return 'punctuation';
  }
  if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return 'number';
  if (stream.match(/^(true|false)\b/)) return 'bool';
  if (stream.match(/^null\b/)) return 'atom';
  stream.next();
  return 'invalid';
}

/** JSON. */
export function json(): Language {
  return streamLanguage<JsonState>({
    name: 'json',
    languageData: { indentAfter: /[[{]\s*$/ },
    startState: () => ({ ctx: '', expectKey: false }),
    token,
  });
}
