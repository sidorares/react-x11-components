// SQL, as a stream mode. Written here rather than pulled from an ecosystem
// because the obvious donor (`@codemirror/lang-sql`) depends on the whole
// CodeMirror editor core (`@codemirror/state`, `language`, `autocomplete`),
// which is a lot of install closure for a keyword list — see AGENTS.md on
// why that trade is taken seriously. Tokenizing SQL (not parsing it!) is
// small: strings, quoted identifiers, comments, numbers, parameters,
// keywords.
import { streamLanguage } from '../stream.js';
import type { StringStream } from '../stream.js';
import type { Language } from '../types.js';

const KEYWORDS = new Set(
  (
    'add all alter and any as asc autoincrement between by cascade case cast ' +
    'check collate column commit constraint create cross current current_date ' +
    'current_time current_timestamp database default delete desc distinct drop ' +
    'else end escape except exists explain fetch filter first following for ' +
    'foreign from full generated group grouping having if ignore ilike in index ' +
    'inner insert intersect into is join key last lateral left like limit ' +
    'materialized natural no not null nulls of offset on only or order outer ' +
    'over partition preceding primary range recursive references rename ' +
    'replace restrict returning right rollback row rows select set show some ' +
    'table temporary then to transaction trigger truncate union unique update ' +
    'using values view when where window with without'
  ).split(' '),
);

const TYPES = new Set(
  (
    'bigint binary bit blob boolean char character clob date datetime decimal ' +
    'double enum float int integer interval json jsonb numeric precision real ' +
    'serial smallint text time timestamp timestamptz tinyint uuid varbinary ' +
    'varchar'
  ).split(' '),
);

const BUILTINS = new Set(
  (
    'abs avg ceil coalesce concat count floor greatest ifnull least length ' +
    'lower ltrim max min mod now nullif power random round rtrim substr ' +
    'substring sum trim upper'
  ).split(' '),
);

const ATOMS = new Set(['true', 'false', 'unknown']);

const OPERATOR = /[+\-*/<>=~!|&%^]/;
const PUNCT = /[;,.]/;
const BRACKET = /[()]/;

interface SqlState {
  /** Inside a `/* … *​/` comment that has not closed yet. */
  comment: boolean;
  /** Inside a `'…'` string that has not closed yet — SQL strings may span
   * lines. */
  string: boolean;
}

/** Consume string content until an un-doubled closing quote or the line
 * ends; report whether it closed. */
function eatStringTail(stream: StringStream): boolean {
  while (!stream.eol()) {
    if (stream.eat("'")) {
      if (!stream.eat("'")) return true; // a lone quote closes; '' is an escape
    } else {
      stream.next();
    }
  }
  return false;
}

/** Options for {@link sql}. All additive — the base is generic ANSI-ish. */
export interface SqlOptions {
  /** Extra keywords, e.g. a dialect's. Matched case-insensitively. */
  keywords?: readonly string[];
  /** Treat `#` as a line comment (MySQL). `--` and `/* *​/` always work. */
  hashComments?: boolean;
}

/** SQL. `sql()` for the generic dialect, options for the house one. */
export function sql(options: SqlOptions = {}): Language {
  const extra = new Set(
    (options.keywords ?? []).map((word) => word.toLowerCase()),
  );

  function token(stream: StringStream, state: SqlState): string | null {
    if (state.comment) {
      if (stream.match(/^.*?\*\//)) state.comment = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (state.string) {
      state.string = !eatStringTail(stream);
      return 'string';
    }
    if (stream.eatSpace()) return null;

    if (stream.match('--')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (options.hashComments && stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.comment = true;
      if (stream.match(/^.*?\*\//)) state.comment = false;
      else stream.skipToEnd();
      return 'comment';
    }

    // 'string' — standard escapes the quote by doubling it; may span lines
    if (stream.eat("'")) {
      state.string = !eatStringTail(stream);
      return 'string';
    }
    // "quoted identifier" / `mysql identifier`
    const identQuote = stream.eat('"') ?? stream.eat('`');
    if (identQuote) {
      stream.eatWhile((ch) => ch !== identQuote);
      stream.eat(identQuote);
      return 'variableName';
    }

    // parameters: $1, :name, @name, ?
    if (stream.match(/^\$\d+/) || stream.match(/^[:@][A-Za-z_][\w$]*/)) {
      return 'atom';
    }
    if (stream.eat('?')) return 'atom';

    if (stream.match(/^\d+(\.\d*)?([eE][+-]?\d+)?/) || stream.match(/^\.\d+/)) {
      return 'number';
    }

    if (stream.match(/^[A-Za-z_][\w$]*/)) {
      const word = stream.current().toLowerCase();
      if (KEYWORDS.has(word) || extra.has(word)) return 'keyword';
      if (TYPES.has(word)) return 'typeName';
      if (ATOMS.has(word)) return 'atom';
      if (BUILTINS.has(word) && stream.match(/^\s*\(/, false)) {
        return 'function';
      }
      return null;
    }

    if (stream.eat(BRACKET)) return 'bracket';
    if (stream.eat(PUNCT)) return 'punctuation';
    if (stream.eatWhile(OPERATOR)) return 'operator';
    stream.next();
    return null;
  }

  return streamLanguage<SqlState>({
    name: 'sql',
    languageData: {
      lineComment: '--',
      wordChars: '$',
      completions: [...KEYWORDS, ...TYPES, ...BUILTINS].sort(),
      indentAfter: /[([]\s*$/,
    },
    startState: () => ({ comment: false, string: false }),
    token,
  });
}
