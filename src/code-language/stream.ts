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
  TokenizerHost,
} from './types.js';
import { spliceAll } from '../internal/splice.js';
import { startTimeout, stopTimeout, type TimerId } from './timers.js';

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

/**
 * How much of one line is tokenized; the rest of a longer one is drawn
 * unstyled, and the next line starts from the state where this one was cut.
 * CodeMirror's `maxHighlightLength`, and for the same reason: a line is
 * tokenized again whole on every edit to it, and a minified file is one
 * line — a keystroke at the end of a million characters ran the language
 * over all of them. A construct that opens past the cut and closes on a
 * later line is the price, on lines no one reads by their colours.
 */
export const TOKENIZE_LIMIT = 10_000;

/**
 * How far past the frontier a request walks it on the spot. Further than
 * that — the end of a file opened a moment ago, a line a search jumped to —
 * the line is tokenized from a guessed state, and the frontier is walked
 * there in the background, `SLICE_LINES` a turn, with the host told where a
 * guess was wrong. CodeMirror 5's answer to the same jump, for the same
 * reason: tokenizing a 50,000-line file is a fifth of a second, spent on
 * lines no one is looking at. Decided by the distance rather than by trying:
 * the lines a guess would take from the cache are the ones the walk would
 * have found converged, and trying first is the cost this exists to avoid.
 */
export const SYNC_LINES = 1_000;
const SLICE_LINES = 500;

/** How far above a guessed line to look for a state to start from: one a
 *  guess left, or else the least indented line, taken to be at the top
 *  level (CodeMirror's `findStartLine`). */
const GUESS_LOOKBACK = 100;

function cut(text: string): string {
  return text.length > TOKENIZE_LIMIT ? text.slice(0, TOKENIZE_LIMIT) : text;
}

function indentOf(text: string): number {
  let n = 0;
  while (n < text.length && (text[n] === ' ' || text[n] === '\t')) n++;
  return n;
}

function sameTokens(a: readonly Token[], b: readonly Token[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.from !== y.from || x.to !== y.to || x.type !== y.type) return false;
  }
  return true;
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
 *
 * A guess (`guess`) is one more such pair past the frontier: tokens run
 * from a state that was not reached from line 0. Convergence is what makes
 * that safe as well — the frontier's walk takes the rest of a guessed run
 * as it is where it arrives with the same state, and tokenizes it again
 * where it does not.
 */
class StreamTokenizer<S> implements Tokenizer {
  private lines: readonly string[] = [''];
  /** states[i] = state entering line i. Trusted for i <= frontier; a
   * defined entry beyond that is a pre-edit value or a guess, used only as
   * a convergence candidate. Past the frontier every defined `tokens[i]` was
   * run from the `states[i]` beside it. */
  private states: (S | undefined)[] = [];
  private tokens: (Token[] | undefined)[] = [];
  /** Lines `[0, frontier)` have trusted tokens. */
  private frontier = 0;
  /** The furthest line answered from a guess that the frontier has not
   *  reached; -1 when there is none. While there is one, every line past
   *  the frontier is answered the same way. */
  private guessedTo = -1;
  private worker: TimerId = null;
  /** The first line whose trusted tokens differed from the ones it had —
   *  what the host is told after a turn of the walk. */
  private changedFrom = -1;

  constructor(
    private readonly mode: LineMode<S>,
    private readonly host: TokenizerHost | null = null,
  ) {}

  setLines(lines: readonly string[]): void {
    this.lines = lines;
    this.states = new Array(lines.length + 1);
    this.tokens = new Array(lines.length);
    this.states[0] = this.mode.startState();
    this.frontier = 0;
    this.guessedTo = -1;
    this.stopWorker();
  }

  edit({ fromLine, removed, inserted }: LineEdit): void {
    // Align the caches below the edit with the new line numbering (their
    // contents may still be right — convergence will decide), and punch
    // `undefined` holes for the lines whose text actually changed.
    //
    // …all but one: the state entering the first line after the edit is
    // put back at that line's new number. It is what convergence compares
    // the edit's outgoing state with, paired with the tokens that line
    // still has — punched out with the rest, every edit re-tokenized the
    // line after it too, and handed back a new token array for text that
    // had not changed.
    const after = this.states[fromLine + removed];
    spliceAll(this.states, fromLine + 1, removed, new Array(inserted));
    if (inserted > 0) this.states[fromLine + inserted] = after;
    spliceAll(this.tokens, fromLine, removed, new Array(inserted));
    this.frontier = Math.min(this.frontier, fromLine);
    if (this.guessedTo >= fromLine) {
      this.guessedTo = Math.max(fromLine, this.guessedTo + inserted - removed);
    }
  }

  lineTokens(line: number): readonly Token[] {
    if (line < 0 || line >= this.lines.length) return [];
    if (line >= this.frontier) {
      if (this.guessedTo >= 0 || line - this.frontier > SYNC_LINES) {
        return this.guess(line);
      }
      this.ensure(line);
      // the caller has the tokens: nobody else was holding the old ones
      this.changedFrom = -1;
    }
    return this.tokens[line] ?? [];
  }

  dispose(): void {
    this.stopWorker();
  }

  /**
   * Walk the frontier to `line`, tokenizing at most `budget` lines on the
   * way (a converged run skipped is free). False when the budget ran out
   * first.
   */
  private ensure(line: number, budget = Infinity): boolean {
    const copy = this.mode.copyState ?? defaultCopy;
    const equals = this.mode.stateEquals ?? defaultEquals;
    let spent = 0;
    while (this.frontier <= line) {
      if (spent++ >= budget) return false;
      const i = this.frontier;
      // `states[i]` is trusted here: it is either below the old frontier or
      // was written by the previous iteration. Copy before running — the
      // mode mutates in place, and the cached entry must stay pristine.
      const state = copy(this.states[i] as S);
      this.tokens[i] = this.run(i, state);
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
    return true;
  }

  /**
   * Tokens for a line past the frontier, where the frontier is too far to
   * walk to now: walked from the furthest state up the `GUESS_LOOKBACK`
   * lines above it — the frontier's, when it is that close, or one a guess
   * or an edit left — or, when there is none, from the language's start
   * state at the least indented of those lines. The walk runs what has no
   * tokens and passes over what has, so an edit's line is run again and the
   * lines under it follow, the way the frontier walks after an edit; a line
   * whose entering state it changes loses its tokens, since they ran from
   * the state it replaced. What it writes are pairs like any other past the
   * frontier, which the frontier's walk, started here, takes or tokenizes
   * again when it arrives.
   */
  private guess(line: number): readonly Token[] {
    this.guessedTo = Math.max(this.guessedTo, line);
    this.schedule();
    const floor = Math.max(this.frontier, line - GUESS_LOOKBACK);
    let from = floor;
    while (from < line && this.states[from] === undefined) from++;
    if (this.states[from] === undefined) {
      let least = Infinity;
      for (let i = line; i >= floor; i--) {
        const text = this.lines[i];
        const indent = indentOf(text);
        if (indent === text.length) continue; // blank says nothing
        if (indent < least) {
          least = indent;
          from = i;
        }
      }
      this.states[from] = this.mode.startState();
      this.tokens[from] = undefined;
    }
    const copy = this.mode.copyState ?? defaultCopy;
    const equals = this.mode.stateEquals ?? defaultEquals;
    // whether the state entering line `i` was just replaced, so its tokens
    // ran from another and it is run again, beside what it had
    let moved = false;
    for (let i = from; i <= line; i++) {
      // a pair past the frontier ran from the state beside it; the
      // frontier's may be from before the walk replaced its state
      if (
        !moved &&
        i > this.frontier &&
        this.tokens[i] !== undefined &&
        this.states[i + 1] !== undefined
      ) {
        continue;
      }
      const state = copy(this.states[i] as S);
      this.tokens[i] = this.run(i, state);
      const next = this.states[i + 1];
      moved = next === undefined || !equals(state, next);
      if (moved) this.states[i + 1] = state;
    }
    // past the line asked about, what ran from a replaced state goes: it is
    // run again when asked for, and whoever was handed it is told
    const after = line + 1;
    if (moved && this.tokens[after] !== undefined) {
      this.tokens[after] = undefined;
      this.noteChange(after);
    }
    return this.tokens[line] ?? [];
  }

  /**
   * Run line `i` from `state`, which it leaves as the line leaves it. The
   * tokens it had, when they come out the same, are kept rather than
   * replaced — an editor holds a line's layout by them — and where they do
   * not, the line is noted for the host.
   */
  private run(i: number, state: S): Token[] {
    const had = this.tokens[i];
    const tokens = this.mode.runLine(cut(this.lines[i]), state);
    if (had === undefined) return tokens;
    if (sameTokens(had, tokens)) return had;
    this.noteChange(i);
    return tokens;
  }

  private noteChange(i: number): void {
    if (this.changedFrom < 0 || i < this.changedFrom) this.changedFrom = i;
  }

  private schedule(): void {
    if (this.worker != null) return;
    this.worker = startTimeout(() => this.work(), 0);
  }

  /** One turn of the walk to the furthest guess, and the host told of the
   *  first line it found a guess wrong on. */
  private work(): void {
    this.worker = null;
    if (this.guessedTo < 0) return;
    const to = Math.min(this.guessedTo, this.lines.length - 1);
    const done = this.ensure(to, SLICE_LINES);
    const changed = this.changedFrom;
    this.changedFrom = -1;
    if (done) this.guessedTo = -1;
    else this.schedule();
    if (changed >= 0) this.host?.invalidate(changed);
  }

  private stopWorker(): void {
    stopTimeout(this.worker);
    this.worker = null;
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
    createTokenizer: (host) => new StreamTokenizer(mode, host),
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
