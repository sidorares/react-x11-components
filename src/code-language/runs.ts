// Static highlighting: text + fence tag → styled runs, ready for a
// TextLayout-shaped consumer (`<richtext>` speaks exactly this shape,
// structurally — this module deliberately imports nothing from it).
//
// The chain is: an explicit `language`, else `resolveLanguage(tag)` if the
// caller supplied one, else a built-in tokenizer for the tag, else one plain
// run. Every step degrades to readable.
//
// The third step used to be ntk's `highlightCode` — a MarkdownView-internal
// this module reached for by name, so that a fence tagged `python` got
// highlighted without the app arranging anything. ntk's document widgets are
// being decommissioned and it goes with them; `resolveLanguage` is what
// replaces it, and `hljsLanguage` (./hljs.ts) is the same highlight.js
// breadth as a `Language` the app opts into:
//
// ```ts
// import hljs from 'highlight.js/lib/common';
// codeRuns(text, tag, { …, resolveLanguage: (t) => hljsLanguage({hljs, name: t}) })
// ```
//
// Explicit rather than automatic, because the alternative is this package
// depending on highlight.js for every app that renders a fence — see
// AGENTS.md on tree-shaking, and `textmate.ts` for the same shape.
import { languageForTag, tokenizeText } from './registry.js';
import { tokenStyleFor } from './theme.js';
import type { Language, Token, Tokenizer, TokenStyles } from './types.js';

/** One styled run of code. Structurally a `<richtext>` run. */
export interface CodeRun {
  text: string;
  color?: string;
  weight?: number;
  style?: 'normal' | 'italic';
}

export interface CodeRunOptions {
  /** Token palette; `autoTokenStyles(background)` picks a built-in one. */
  styles: TokenStyles;
  /** The plain-text colour for gaps and unstyled tokens. */
  color: string;
  /** Resolves a `'$token'` colour a custom palette may use; unresolved
   *  `$tokens` drop to the plain colour rather than reaching the paint
   *  path as literal dollar strings. */
  resolveToken?: (name: string) => string | undefined;
  /** An explicit `Language` (a Lezer or TextMate adapter, say) — takes
   *  precedence over whatever the tag would have resolved to. */
  language?: Language;
  /**
   * A `Language` for a fence tag the built-ins do not cover — the seam for
   * highlight.js (`hljsLanguage`), a Lezer grammar per tag, or a lookup of
   * the app's own. Consulted before {@link languageForTag}, so it can also
   * override a built-in; `null` for a tag it does not know.
   */
  resolveLanguage?: (tag: string) => Language | null;
}

function runColor(
  color: string | undefined,
  opts: CodeRunOptions,
): string | undefined {
  if (!color) return undefined;
  if (color.startsWith('$'))
    return opts.resolveToken?.(color.slice(1)) ?? undefined;
  return color;
}

/**
 * Highlight `text` as `tag` (a fence tag: `js`, `bash`, …). The runs
 * concatenate back to exactly `text`; an empty or unknown tag yields one
 * plain run.
 */
export function codeRuns(
  text: string,
  tag: string,
  opts: CodeRunOptions,
): CodeRun[] {
  if (text.length === 0) return [{ text: '', color: opts.color }];

  const language =
    opts.language ??
    (tag ? (opts.resolveLanguage?.(tag) ?? languageForTag(tag)) : null);
  if (language) {
    const perLine = tokenizeText(language, text);
    const lines = text.split('\n');
    const out: CodeRun[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (i > 0) push(out, '\n', undefined, opts);
      let at = 0;
      for (const t of perLine[i]) {
        if (t.from > at) push(out, line.slice(at, t.from), undefined, opts);
        push(out, line.slice(t.from, t.to), t.type, opts);
        at = t.to;
      }
      if (at < line.length) push(out, line.slice(at), undefined, opts);
    }
    return out;
  }

  return [{ text, color: opts.color }];
}

function push(
  out: CodeRun[],
  text: string,
  type: string | undefined,
  opts: CodeRunOptions,
): void {
  if (text.length === 0) return;
  const style = type ? tokenStyleFor(opts.styles, type) : null;
  const run: CodeRun = {
    text,
    color: runColor(style?.color, opts) ?? opts.color,
  };
  if (style?.weight) run.weight = style.weight;
  if (style?.fontStyle) run.style = style.fontStyle;
  const prev = out[out.length - 1];
  if (
    prev &&
    prev.color === run.color &&
    prev.weight === run.weight &&
    prev.style === run.style
  ) {
    prev.text += text;
  } else {
    out.push(run);
  }
}

/**
 * `codeRuns`, kept between calls for a text that changes a little at a
 * time: a fence being streamed, a source being appended to.
 *
 * One tokenizer lives as long as the cache. It is told which lines changed
 * (`Tokenizer.edit`, the interface `<CodeEditor>` already drives) and asked
 * again only for those and the lines after them its state has to walk
 * through, and every other line keeps the runs it had. `codeRuns` tokenized
 * the whole text afresh: at 5,000 lines, most of the time an appended line
 * took on the client.
 *
 * The runs are the same text in the same colours `codeRuns` gives, cut a
 * little differently: a line's runs never reach into the next, and each
 * newline is a run of its own, so that a line keeps its runs while others
 * change. `decorate` is applied to every run once, when it is made — the
 * family and size a block of code is set in, say.
 *
 * Call `dispose()` when done with it: an engine may keep timers.
 */
export class CodeRunCache<R = CodeRun> {
  private key: readonly unknown[] | null = null;
  private tokenizer: Tokenizer | null = null;
  private lines: string[] = [];
  private tokens: (readonly Token[] | undefined)[] = [];
  private lineRuns: (R[] | undefined)[] = [];
  private newline: R | null = null;

  constructor(
    private readonly decorate: (run: CodeRun) => R = (run) => run as R,
  ) {}

  runs(text: string, tag: string, opts: CodeRunOptions): R[] {
    if (text.length === 0)
      return [this.decorate({ text: '', color: opts.color })];
    const language =
      opts.language ??
      (tag ? (opts.resolveLanguage?.(tag) ?? languageForTag(tag)) : null);
    if (!language) return [this.decorate({ text, color: opts.color })];

    const key = [language, opts.styles, opts.color, opts.resolveToken];
    if (!this.key || key.some((part, i) => part !== this.key![i])) {
      this.dispose();
      this.key = key;
      this.lines = [];
      this.tokens = [];
      this.lineRuns = [];
      this.newline = this.decorate({ text: '\n', color: opts.color });
      this.tokenizer = language.createTokenizer({ invalidate: () => {} });
      this.tokenizer.setLines(this.lines);
    }
    const tokenizer = this.tokenizer!;

    // the lines the text shares with the last one, from the top: the edit
    // is everything after them
    const next = text.split('\n');
    const lines = this.lines;
    const shared = Math.min(lines.length, next.length);
    let from = 0;
    while (from < shared && lines[from] === next[from]) from++;
    if (from < lines.length || from < next.length) {
      const removed = lines.length - from;
      const inserted = next.length - from;
      lines.length = from;
      for (let i = from; i < next.length; i++) lines.push(next[i]!);
      tokenizer.edit({ fromLine: from, removed, inserted });
      this.tokens.length = from;
      this.lineRuns.length = from;
    }

    // Asked in order from the top, so a stream engine walks its frontier
    // line by line and answers each exactly, never from a guess.
    const out: R[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) out.push(this.newline!);
      const tokens = tokenizer.lineTokens(i);
      let runs = this.lineRuns[i];
      if (!runs || this.tokens[i] !== tokens) {
        runs = lineRuns(lines[i]!, tokens, opts).map(this.decorate);
        this.lineRuns[i] = runs;
        this.tokens[i] = tokens;
      }
      for (const run of runs) out.push(run);
    }
    return out;
  }

  dispose(): void {
    this.tokenizer?.dispose?.();
    this.tokenizer = null;
    this.key = null;
  }
}

/** One line's runs, as `codeRuns` makes them, up to its end. */
function lineRuns(
  line: string,
  tokens: readonly Token[],
  opts: CodeRunOptions,
): CodeRun[] {
  const out: CodeRun[] = [];
  let at = 0;
  for (const t of tokens) {
    if (t.from > at) push(out, line.slice(at, t.from), undefined, opts);
    push(out, line.slice(t.from, t.to), t.type, opts);
    at = t.to;
  }
  if (at < line.length) push(out, line.slice(at), undefined, opts);
  return out;
}
