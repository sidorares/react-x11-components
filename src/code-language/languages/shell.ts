// POSIX shell / bash, as a stream mode. An honest approximation, not a
// parser: quoting (including `$…` inside double quotes), expansions,
// heredocs with a plain terminator, keywords, common builtins, and the
// command position (the first word of a command paints as `function`, the
// way every terminal theme reads). Arithmetic and the darker corners of
// parameter expansion tokenize as plain text rather than pretending.
import { streamLanguage } from '../stream.js';
import type { StringStream } from '../stream.js';
import type { Language } from '../types.js';

const KEYWORDS = new Set(
  (
    'if then else elif fi for in do done while until case esac function ' +
    'select time coproc return break continue'
  ).split(' '),
);

const BUILTINS = new Set(
  (
    'alias bg cd command echo eval exec exit export fg getopts hash jobs ' +
    'kill let local printf pwd read readonly set shift source test trap ' +
    'type ulimit umask unalias unset wait'
  ).split(' '),
);

/** After these, the next word is a command again. */
const COMMAND_STARTERS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  'time',
  'coproc',
]);

interface ShellState {
  /** Heredoc terminator we are inside of, or `''` when not. */
  heredoc: string;
  /** The heredoc's body is literal (quoted delimiter) — unused for paint
   * today, carried so the state is honest. */
  heredocQuoted: boolean;
  /** Inside a double-quoted string spanning lines. */
  dquote: boolean;
  /** Inside a single-quoted string spanning lines. */
  squote: boolean;
  /** The next bare word is in command position. */
  command: boolean;
  /** After `for`/`case`/`select`: the next `in`/`do` is a keyword even
   * though it is not in command position. */
  expectIn: boolean;
}

function eatDollar(stream: StringStream): string | null {
  // $VAR, ${…}, $(…), $((…)), $?, $#, $@, $*, $$, $!, $0-9
  if (stream.match(/^\$\{[^}]*\}?/)) return 'variableName';
  if (stream.match(/^\$[A-Za-z_]\w*/)) return 'variableName';
  if (stream.match(/^\$[?#@*$!0-9-]/)) return 'variableName';
  if (stream.match(/^\$\(\(?/)) return 'punctuation'; // $( / $(( opener
  return null;
}

function token(stream: StringStream, state: ShellState): string | null {
  if (state.heredoc) {
    // The terminator must be the whole line; `<<-` also allows leading
    // tabs. Close enough for painting.
    if (stream.sol()) {
      stream.match(/^\t+/);
      if (stream.match(state.heredoc) && stream.eol()) {
        state.heredoc = '';
        state.command = true; // the line after the body starts a command
        return 'atom';
      }
      stream.pos = 0; // not the terminator after all
    }
    stream.skipToEnd();
    return 'string2';
  }

  // a newline ends a command, so a fresh line is command position again
  // (line continuations via a trailing backslash are ignored — a cheap
  // approximation this mode owns up to)
  if (stream.sol() && !state.dquote && !state.squote) state.command = true;

  if (state.squote) {
    stream.eatWhile((ch) => ch !== "'");
    if (stream.eat("'")) state.squote = false;
    return 'string';
  }
  if (state.dquote) return dquoteToken(stream, state);

  if (stream.eatSpace()) return null;

  const ch = stream.peek();

  if (ch === '#') {
    stream.skipToEnd();
    return stream.string.startsWith('#!') && stream.start === 0
      ? 'meta' // shebang
      : 'comment';
  }

  // heredoc opener: << or <<- then an optional-quoted terminator
  const here = stream.match(
    /^<<-?\s*(["']?)([A-Za-z_]\w*)\1/,
  ) as RegExpMatchArray | null;
  if (here) {
    state.heredoc = here[2];
    state.heredocQuoted = here[1] !== '';
    return 'operator';
  }

  if (ch === "'") {
    stream.next();
    state.squote = true;
    stream.eatWhile((c) => c !== "'");
    if (stream.eat("'")) state.squote = false;
    return 'string';
  }
  if (ch === '"') {
    stream.next();
    state.dquote = true;
    return 'string';
  }
  if (ch === '`') {
    stream.next();
    state.command = true;
    return 'punctuation';
  }

  const dollar = eatDollar(stream);
  if (dollar) return dollar;

  if (stream.match(/^\\./)) return 'escape';

  // operators that also reset the command position
  if (stream.match(/^(\|\||&&|;;|[|&;])/)) {
    state.command = true;
    return 'operator';
  }
  if (stream.match(/^(>>|<<|[<>]&?|\d+[<>])/)) return 'operator';
  if (stream.match(/^(\(|\)|\{|\}|\[\[|\]\]|\[|\])/)) {
    state.command = true;
    return 'bracket';
  }
  if (stream.match(/^=/)) {
    state.command = false;
    return 'operator';
  }

  if (stream.match(/^[A-Za-z_][\w-]*/)) {
    const word = stream.current();
    // NAME=value — an assignment, not a command
    if (stream.match(/^\+?=/, false)) {
      return 'variableName';
    }
    // Reserved words are reserved *in command position* — `echo done` is a
    // word named done, not a loop end. `in`/`do` additionally read as
    // keywords right after `for`/`case`/`select`.
    if (KEYWORDS.has(word) && state.command) {
      state.command = COMMAND_STARTERS.has(word);
      state.expectIn = word === 'for' || word === 'case' || word === 'select';
      return 'keyword';
    }
    if (state.expectIn && word === 'in') {
      state.expectIn = false;
      return 'keyword';
    }
    if (state.command) {
      state.command = false;
      return 'function'; // the command name, builtin or not
    }
    return null;
  }

  if (stream.match(/^\d+/)) return 'number';

  stream.next();
  return null;
}

/** Inside `"…"`: expansions still highlight, `\"` escapes, may span lines. */
function dquoteToken(stream: StringStream, state: ShellState): string | null {
  if (stream.eat('"')) {
    state.dquote = false;
    return 'string';
  }
  if (stream.match(/^\\./)) return 'escape';
  const dollar = eatDollar(stream);
  if (dollar) return dollar;
  while (!stream.eol()) {
    const next = stream.peek();
    if (next === '"' || next === '$' || next === '\\') break;
    stream.next();
  }
  return 'string';
}

/** POSIX shell / bash. */
export function shell(): Language {
  return streamLanguage<ShellState>({
    name: 'shell',
    languageData: {
      lineComment: '#',
      wordChars: '-',
      completions: [...KEYWORDS, ...BUILTINS].sort(),
      indentAfter: /\b(then|do|else|in)\s*$|[({]\s*$/,
    },
    startState: () => ({
      heredoc: '',
      heredocQuoted: false,
      dquote: false,
      squote: false,
      command: true,
      expectIn: false,
    }),
    token,
  });
}
