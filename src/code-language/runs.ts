// Static highlighting: text + fence tag → styled runs, ready for a
// TextLayout-shaped consumer (`<richtext>` speaks exactly this shape,
// structurally — this module deliberately imports nothing from it).
//
// The chain is: built-in tokenizer for the tag, else ntk's highlight.js
// adapter when this ntk still ships it (it lives beside the deprecated
// widgets, so it is reached for by name and allowed to be absent), else
// one plain run. Every step degrades to readable.
import * as ntk from 'react-x11/ntk';

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

/** ntk's fence tokenizer — a maintained adapter over highlight.js, already
 *  in ntk's dependency closure. Loose-typed like the rest of `ntk.d.ts`. */
interface HljsToken {
  text: string;
  kind: string;
}
const hljsTokenize = (
  ntk as unknown as {
    highlightCode?: (code: string, lang: string) => HljsToken[];
  }
).highlightCode;

/** highlight.js kinds → the token vocabulary in `types.ts`. */
const HLJS_KINDS: Record<string, string> = {
  keyword: 'keyword',
  literal: 'atom',
  string: 'string',
  number: 'number',
  comment: 'comment',
  tag: 'typeName',
  attr: 'propertyName',
  function: 'function',
};

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

  const language = opts.language ?? (tag ? languageForTag(tag) : null);
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

  if (tag && hljsTokenize) {
    try {
      const tokens = hljsTokenize(text, tag);
      const out: CodeRun[] = [];
      for (const t of tokens) push(out, t.text, HLJS_KINDS[t.kind], opts);
      if (out.length > 0) return out;
    } catch {
      // an unknown language name is not an error, just plain text
    }
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
