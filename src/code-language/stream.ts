// The built-in tokenizing engine: line-state stream tokenization.
//
// A mode reads one line through a `StringStream` and carries a small state
// across line boundaries — the shape CodeMirror 5 ran on for a decade and
// VS Code's Monarch still runs on. It was chosen over a parse-tree engine
// for the out-of-the-box languages because it matches how the editor paints
// (per line, lazily, only the visible window), it makes incremental
// re-tokenization after an edit almost free (recompute from the edited line,
// stop at the first line whose entry state is unchanged), and it costs zero
// dependencies. Real parsers plug in through the same `Language` interface —
// see `./lezer.ts`.

import type {
  Language,
  LanguageData,
  LineEdit,
  Token,
  Tokenizer,
} from './types.js';

/**
 * One line of text with a cursor, the surface a mode's `token()` reads
 * through. The mode consumes some characters and names their token type;
 * the engine turns (start, pos] into a `Token`.
 */
export class StringStream {
  /** Where the current token started. The engine resets it between calls. */
  start = 0;
  pos = 0;

  constructor(readonly string: string) {}

  sol(): boolean {
    return this.pos === 0;
  }
  eol(): boolean {
    return this.pos >= this.string.length;
  }
  peek(): string | undefined {
    return this.string.charAt(this.pos) || undefined;
  }
  next(): string | undefined {
    if (this.pos < this.string.length) return this.string.charAt(this.pos++);
    return undefined;
  }
  /** Consume the next character when it matches (a string or a RegExp). */
  eat(match: string | RegExp | ((ch: string) => boolean)): string | undefined {
    const ch = this.string.charAt(this.pos);
    if (!ch) return undefined;
    const ok =
      typeof match === 'string'
        ? ch === match
        : match instanceof RegExp
          ? match.test(ch)
          : match(ch);
    if (!ok) return undefined;
    this.pos++;
    return ch;
  }
  eatWhile(match: RegExp | ((ch: string) => boolean)): boolean {
    const from = this.pos;
    while (this.eat(match) !== undefined) {
      /* consumed in the condition */
    }
    return this.pos > from;
  }
  eatSpace(): boolean {
    return this.eatWhile(/[\s ]/);
  }
  skipToEnd(): void {
    this.pos = this.string.length;
  }
  /**
   * Match at the cursor. A string compares directly; a RegExp is applied to
   * the rest of the line and must match at its start (anchor with `^`).
   * Consumes on success unless `consume` is `false`.
   */
  match(
    pattern: string | RegExp,
    consume = true,
  ): boolean | RegExpMatchArray | null {
    if (typeof pattern === 'string') {
      if (!this.string.startsWith(pattern, this.pos)) return null;
      if (consume) this.pos += pattern.length;
      return true;
    }
    const m = pattern.exec(this.string.slice(this.pos));
    if (!m || m.index! > 0) return null;
    if (consume) this.pos += m[0].length;
    return m;
  }
  backUp(n: number): void {
    this.pos -= n;
  }
  current(): string {
    return this.string.slice(this.start, this.pos);
  }
}

/**
 * A stream mode: `startState` before line 0, `token` consuming one token at
 * the stream's cursor (return its type, or `null` for plain text), the state
 * mutated in place as it goes.
 *
 * States must be flat bags of primitives (strings, numbers, booleans) —
 * that is what the default `copyState`/`stateEquals` handle, and what makes
 * the stop-early check on re-tokenization cheap. A mode with a stack encodes
 * it as a string (see the JavaScript mode's `ctx`).
 */
export interface StreamMode<S> {
  name: string;
  languageData?: LanguageData;
  startState(): S;
  token(stream: StringStream, state: S): string | null;
  /** Override when a state is not a flat bag of primitives. */
  copyState?(state: S): S;
  /** Override alongside `copyState`, and keep the two consistent. */
  stateEquals?(a: S, b: S): boolean;
}

/**
 * What the engine actually runs on: a whole-line tokenizer with carried
 * state. `streamLanguage` builds one from a character-level `StreamMode`;
 * the TextMate adapter builds one directly, because its grammars tokenize
 * whole lines natively. Both get the same caching and convergence.
 */
export interface LineMode<S> {
  name: string;
  languageData?: LanguageData;
  startState(): S;
  runLine(text: string, state: S): Token[];
  copyState?(state: S): S;
  stateEquals?(a: S, b: S): boolean;
}

function defaultCopy<S>(state: S): S {
  if (state === null || typeof state !== 'object') return state;
  return { ...(state as object) } as S;
}

function defaultEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  ) {
    return false;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (
      (a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The engine. Caches, per line, the state *entering* it (`states[i]`) and
 * the tokens it produced (`tokens[i]`), the two written together so a cached
 * pair is always self-consistent. `edit()` splices the caches to the new
 * line numbering, leaving `undefined` holes exactly where text changed; the
 * next `lineTokens()` re-tokenizes forward from the edit and stops as soon
 * as a freshly computed entry state equals a cached one — the classic
 * convergence trick, and the reason typing at the top of a 10k-line file
 * re-tokenizes until the edit stops mattering (usually one line), not 10k
 * lines. The `undefined` holes are also what makes convergence sound across
 * multiple pending edits: the fast-forward below can never skip over a line
 * whose text changed, because that line's cache is a hole.
 */
class StreamTokenizer<S> implements Tokenizer {
  private lines: readonly string[] = [''];
  /** states[i] = state entering line i. Trusted for i <= frontier; a
   * defined entry beyond that is a pre-edit value, used only as a
   * convergence candidate. */
  private states: (S | undefined)[] = [];
  private tokens: (Token[] | undefined)[] = [];
  /** Lines `[0, frontier)` have trusted tokens. */
  private frontier = 0;

  constructor(private readonly mode: LineMode<S>) {}

  setLines(lines: readonly string[]): void {
    this.lines = lines;
    this.states = new Array(lines.length + 1);
    this.tokens = new Array(lines.length);
    this.states[0] = this.mode.startState();
    this.frontier = 0;
  }

  edit({ fromLine, removed, inserted }: LineEdit): void {
    // Align the caches below the edit with the new line numbering (their
    // contents may still be right — convergence will decide), and punch
    // `undefined` holes for the lines whose text actually changed.
    this.states.splice(
      fromLine + 1,
      removed,
      ...new Array<S | undefined>(inserted),
    );
    this.tokens.splice(
      fromLine,
      removed,
      ...new Array<Token[] | undefined>(inserted),
    );
    this.frontier = Math.min(this.frontier, fromLine);
  }

  lineTokens(line: number): readonly Token[] {
    if (line < 0 || line >= this.lines.length) return [];
    this.ensure(line);
    return this.tokens[line] ?? [];
  }

  private ensure(line: number): void {
    const copy = this.mode.copyState ?? defaultCopy;
    const equals = this.mode.stateEquals ?? defaultEquals;
    while (this.frontier <= line) {
      const i = this.frontier;
      // `states[i]` is trusted here: it is either below the old frontier or
      // was written by the previous iteration. Copy before running — the
      // mode mutates in place, and the cached entry must stay pristine.
      const state = copy(this.states[i] as S);
      this.tokens[i] = this.mode.runLine(this.lines[i], state);
      const cached = this.states[i + 1];
      if (
        cached !== undefined &&
        this.tokens[i + 1] !== undefined &&
        equals(state, cached)
      ) {
        // Converged: the cached suffix is still right (same entry state,
        // and every cached pair was computed from the text it sits beside —
        // an edit would have punched a hole). Fast-forward to the next hole
        // and resume tokenizing for real there, if the caller needs it.
        let f = i + 1;
        while (
          f < this.lines.length &&
          this.tokens[f] !== undefined &&
          this.states[f + 1] !== undefined
        ) {
          f++;
        }
        this.frontier = f;
        continue;
      }
      this.states[i + 1] = state;
      this.frontier = i + 1;
    }
  }
}

/** Run one line of a character-level mode, merging same-type runs. */
function runStreamLine<S>(
  mode: StreamMode<S>,
  text: string,
  state: S,
): Token[] {
  const out: Token[] = [];
  const stream = new StringStream(text);
  while (!stream.eol()) {
    stream.start = stream.pos;
    const type = mode.token(stream, state);
    if (stream.pos <= stream.start) {
      // A mode that consumes nothing would loop forever; skip a character
      // and paint it plain, which also makes mode bugs visible instead of
      // hanging the app.
      stream.pos = stream.start + 1;
    }
    if (type) {
      const last = out[out.length - 1];
      if (last && last.to === stream.start && last.type === type) {
        last.to = stream.pos; // merge adjacent same-type runs
      } else {
        out.push({ from: stream.start, to: stream.pos, type });
      }
    }
  }
  return out;
}

/** Wrap a whole-line {@link LineMode} as a {@link Language} — the seam the
 * TextMate adapter enters through. */
export function lineModeLanguage<S>(mode: LineMode<S>): Language {
  return {
    name: mode.name,
    data: mode.languageData,
    createTokenizer: () => new StreamTokenizer(mode),
  };
}

/** Wrap a {@link StreamMode} as a {@link Language}. */
export function streamLanguage<S>(mode: StreamMode<S>): Language {
  return lineModeLanguage({
    name: mode.name,
    languageData: mode.languageData,
    startState: mode.startState,
    runLine: (text, state) => runStreamLine(mode, text, state),
    copyState: mode.copyState,
    stateEquals: mode.stateEquals,
  });
}
