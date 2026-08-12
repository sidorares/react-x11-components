// The language seam `<CodeEditor>` is built around.
//
// The editor itself knows nothing about any language. It owns the text, the
// caret and the pixels; everything language-shaped arrives through the
// interfaces in this file, and three very different ecosystems are expected
// to sit behind them:
//
// - the built-in stream tokenizers (`./stream.ts`, `./languages/*`) — zero
//   dependencies, written here, line-state based the way CodeMirror 5 modes
//   and VS Code's Monarch grammars are;
// - Lezer parsers (`./lezer.ts`) — CodeMirror 6's incremental parsers,
//   `@lezer/<lang>` packages, adapted through `@lezer/highlight`;
// - TextMate grammars (`./textmate.ts`) — the VS Code / Shiki grammar world,
//   adapted structurally so this package depends on none of it.
//
// The reason the seam is *pull-based and per-line* (`lineTokens(i)`) rather
// than a push of the whole document's spans: the editor paints only the
// visible window of lines, and an engine should never be forced to tokenize
// a megabyte because line 3 changed. Engines that work document-wide (Lezer)
// cache internally and slice.

/**
 * One highlighted run within a line. Offsets are UTF-16 indices into the
 * line's text (what `String.prototype.slice` takes), `from` inclusive, `to`
 * exclusive. Runs never overlap; gaps between runs paint as plain text.
 */
export interface Token {
  from: number;
  to: number;
  /** A name from {@link TokenType}, or any string a custom theme knows. */
  type: string;
}

/**
 * The token vocabulary the built-in languages emit and the built-in themes
 * style. It is deliberately the vocabulary of Lezer's `classHighlighter`
 * (minus the `tok-` prefix), so a Lezer grammar highlights correctly with no
 * mapping table, and a TextMate scope maps onto it in one step.
 *
 * A theme may style any string; unknown types fall back through
 * {@link TOKEN_FALLBACK} and then to the editor's plain text colour, so a
 * language inventing `'heredoc'` degrades to readable rather than invisible.
 */
export type TokenType =
  | 'keyword'
  | 'operator'
  | 'variableName'
  | 'typeName'
  | 'propertyName'
  | 'className'
  | 'labelName'
  | 'namespace'
  | 'macroName'
  | 'function'
  | 'string'
  | 'string2' // regexes, heredocs — "string, but the other kind"
  | 'escape'
  | 'number'
  | 'bool'
  | 'atom'
  | 'self'
  | 'unit'
  | 'modifier'
  | 'comment'
  | 'docComment'
  | 'meta' // preprocessor, shebangs, annotations
  | 'punctuation'
  | 'bracket'
  | 'invalid';

/** How one token type paints. `color` may be a `$token` from the react-x11
 * theme (`'$dim'`), resolved against the editor's own `theme` at paint. */
export interface TokenStyle {
  color?: string;
  /** ntk font weight, 100–900. */
  weight?: number;
  /** `'italic'` is the one that earns its keep, for comments. */
  fontStyle?: 'normal' | 'italic';
}

/** A token-type → style map. Missing entries fall back via
 * {@link TOKEN_FALLBACK}, then to the editor's text colour. */
export type TokenStyles = Readonly<Record<string, TokenStyle>>;

/**
 * Where an unknown or unstyled token type borrows its style from before
 * giving up and painting plain. `string2 → string`, `docComment → comment`,
 * and so on. Exported because a custom theme wants to know what it may omit.
 */
export const TOKEN_FALLBACK: Readonly<Record<string, string>> = {
  string2: 'string',
  escape: 'string',
  docComment: 'comment',
  bool: 'atom',
  self: 'keyword',
  modifier: 'keyword',
  macroName: 'meta',
  namespace: 'typeName',
  className: 'typeName',
  labelName: 'variableName',
  function: 'variableName',
  unit: 'number',
  bracket: 'punctuation',
};

/**
 * A line-level description of an edit, handed to the tokenizer *after* the
 * editor's line buffer has been updated. `fromLine` is the first affected
 * line; `removed` lines were deleted there and `inserted` lines now sit in
 * their place. A same-line edit is `{ fromLine: n, removed: 1, inserted: 1 }`.
 */
export interface LineEdit {
  fromLine: number;
  removed: number;
  inserted: number;
}

/**
 * What the editor hands an engine at creation time. `invalidate(fromLine)`
 * is for engines that tokenize asynchronously (Lezer reparsing on a debounce,
 * an LSP answering semantic tokens): call it when lines at or below
 * `fromLine` have new tokens, and the editor repaints and pulls again.
 * Synchronous engines never need it.
 */
export interface TokenizerHost {
  invalidate(fromLine: number): void;
}

/**
 * The per-document tokenizing instance. `setLines` hands over the editor's
 * live line array — the tokenizer may keep the reference (the editor edits
 * that array in place and guarantees an `edit()` call after every mutation)
 * but must not mutate it. Reading it inside `lineTokens` is the point: an
 * engine that instead snapshots the text at `setLines` time will paint the
 * pre-edit document.
 */
export interface Tokenizer {
  setLines(lines: readonly string[]): void;
  edit(edit: LineEdit): void;
  /** Tokens for one line, sorted, non-overlapping. `[]` is a fine answer —
   * it is what "plain text" looks like. */
  lineTokens(line: number): readonly Token[];
  /** Drop timers, workers, subscriptions. Called on unmount and when the
   * editor switches to a different `language`. */
  dispose?(): void;
}

/**
 * Metadata about a language that is not tokenization: what the editor's own
 * commands (Ctrl+/, auto-indent) and the generic completion sources read.
 * All optional — a language that only tokenizes is complete.
 */
export interface LanguageData {
  /** `'--'`, `'#'`, `'//'` — enables Ctrl+/ toggle-comment. */
  lineComment?: string;
  /** Extra word characters for double-click and Ctrl+arrow, on top of
   * letters, digits and `_` (SQL wants `$`, shell wants `-`). */
  wordChars?: string;
  /** Words for `keywordCompletionSource` — usually the keyword list the
   * tokenizer matches, re-exported. */
  completions?: readonly string[];
  /** After Enter, indent one unit deeper when the previous line matches.
   * The built-ins use `/[([{]\s*$/`. */
  indentAfter?: RegExp;
}

/** What `<CodeEditor language>` takes: a named factory for tokenizers. */
export interface Language {
  name: string;
  data?: LanguageData;
  createTokenizer(host: TokenizerHost): Tokenizer;
}

// --- positions, selections, diagnostics ------------------------------------

/** A caret position: `line` is 0-based, `ch` a UTF-16 index into the line. */
export interface Position {
  line: number;
  ch: number;
}

/** `anchor` is where the selection started, `head` where the caret is —
 * equal when nothing is selected. */
export interface Selection {
  anchor: Position;
  head: Position;
}

/**
 * A range to underline. The shape (and the severity names) are LSP's, so a
 * language-server client maps `publishDiagnostics` onto this prop without
 * translation — see the module comment: this is one half of the "language
 * server seam", completions being the other.
 */
export interface Diagnostic {
  from: Position;
  to: Position;
  severity?: 'error' | 'warning' | 'information' | 'hint';
  message?: string;
  /** e.g. the lint rule or LSP `source`. Unused by the paint; carried for
   * the app's own tooltip/status UI. */
  source?: string;
}

// --- completion ------------------------------------------------------------

/** Why a completion query is running. `'explicit'` is Ctrl+Space. */
export type CompletionTrigger = 'input' | 'explicit';

/** What a {@link CompletionSource} is asked with. */
export interface CompletionContext {
  /** The document, by line. Do not mutate. */
  lines: readonly string[];
  /** The caret. */
  pos: Position;
  /** The word being typed: `text` from `from` up to the caret. Sources that
   * complete mid-token re-derive their own; most want this one. */
  word: { from: Position; text: string };
  trigger: CompletionTrigger;
  /** The editor's language, for sources that adapt (keyword lists). */
  language: Language | null;
}

export interface CompletionItem {
  label: string;
  /** Replaces the text from `from` (the source's, else the context word's)
   * to the caret. Defaults to `label`. */
  apply?: string;
  /** Dim text after the label — a type, a table name, a signature. */
  detail?: string;
  /** Groups and ranks like kinds; also the theme hook for a badge later.
   * Free-form; the built-ins use `'keyword' | 'word' | 'table' | 'column'`. */
  kind?: string;
  /** Sort/filter boost, higher wins ties. Default 0. */
  boost?: number;
}

export interface CompletionResult {
  /** Where the replacement starts. Defaults to the context word start. */
  from?: Position;
  items: readonly CompletionItem[];
}

/**
 * One provider of completions. Return `null` for "nothing to say here".
 * May be async — the editor drops a result that arrives after the document
 * moved on. This signature is deliberately LSP-shaped: a client wrapping
 * `textDocument/completion` is just an async source.
 */
export type CompletionSource = (
  context: CompletionContext,
) => CompletionResult | null | Promise<CompletionResult | null>;
