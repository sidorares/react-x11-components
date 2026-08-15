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
import type { Language, TokenStyles } from './types.js';

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
