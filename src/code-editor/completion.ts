// Built-in completion sources, and the ranking shared by the popup.
//
// A source is one async function (see `types.ts`) — deliberately the shape
// of an LSP `textDocument/completion` call, so a language-server client is
// "just another source". The three here cover the out-of-the-box story:
// the language's own keywords, the words already in the document, and a
// schema-aware SQL source that shows what "extendable" means in practice.
import type {
  CompletionContext,
  CompletionItem,
  CompletionResult,
  CompletionSource,
} from '../code-language/types.js';

/**
 * Rank `items` against what has been typed: prefix matches first (case
 * matters more than not), then substring matches, `boost` breaking ties.
 * Exported for apps building their own popup on the same sources.
 */
export function rankCompletions(
  items: readonly CompletionItem[],
  typed: string,
): CompletionItem[] {
  if (typed.length === 0) {
    return [...items].sort(
      (a, b) =>
        (b.boost ?? 0) - (a.boost ?? 0) || a.label.localeCompare(b.label),
    );
  }
  const lower = typed.toLowerCase();
  const scored: Array<{ item: CompletionItem; score: number }> = [];
  for (const item of items) {
    const label = item.label;
    const labelLower = label.toLowerCase();
    let score: number;
    if (label.startsWith(typed)) score = 4;
    else if (labelLower.startsWith(lower)) score = 3;
    else if (labelLower.includes(lower)) score = 1;
    else continue;
    if (label === typed) score += 2;
    scored.push({ item, score: score * 1000 + (item.boost ?? 0) });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label),
  );
  return scored.map((s) => s.item);
}

/**
 * The words of the document itself (excluding the one being typed) — the
 * humble source that makes any editor feel awake. Word characters follow
 * the language's `wordChars`.
 */
export function wordCompletionSource(): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const extra = context.language?.data?.wordChars ?? '';
    const escaped = extra.replace(/[\\\]^-]/g, '\\$&');
    const word = new RegExp(`[\\p{L}\\p{N}_${escaped}]{2,}`, 'gu');
    const seen = new Set<string>();
    const typed = context.word.text;
    for (let i = 0; i < context.lines.length; i++) {
      const line = context.lines[i];
      for (const m of line.matchAll(word)) {
        const w = m[0];
        // the word under the caret completes to itself otherwise
        if (
          i === context.pos.line &&
          m.index === context.word.from.ch &&
          w === typed
        ) {
          continue;
        }
        seen.add(w);
      }
    }
    if (seen.size === 0) return null;
    return {
      items: [...seen].map((label) => ({ label, kind: 'word', boost: -1 })),
    };
  };
}

/** The language's `data.completions` (keywords, builtins). */
export function keywordCompletionSource(): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const words = context.language?.data?.completions;
    if (!words || words.length === 0) return null;
    return {
      items: words.map((label) => ({ label, kind: 'keyword' })),
    };
  };
}

/** Table name → column names. */
export type SqlSchema = Readonly<Record<string, readonly string[]>>;

/**
 * Schema-aware SQL completion: table names after FROM/JOIN/INTO/UPDATE,
 * `alias.` and `table.` producing that table's columns, and columns
 * everywhere else (boosted below keywords so `SEL…` still completes to
 * SELECT). Alias resolution reads the document, so `FROM users u` makes
 * `u.` complete users' columns.
 */
export function sqlCompletionSource(schema: SqlSchema): CompletionSource {
  const tables = Object.keys(schema);
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.lines[context.pos.line];
    const before = line.slice(0, context.pos.ch);
    const text = context.lines.join('\n');

    // `alias.` / `table.` — complete that table's columns
    const dotted = /([A-Za-z_][\w$]*)\.([\w$]*)$/.exec(before);
    if (dotted) {
      const qualifier = dotted[1];
      let table = tables.find(
        (t) => t.toLowerCase() === qualifier.toLowerCase(),
      );
      if (!table) {
        // resolve an alias: FROM <table> [AS] <alias> / JOIN <table> <alias>
        const alias = new RegExp(
          `(?:from|join|update|into)\\s+([A-Za-z_][\\w$]*)(?:\\s+as)?\\s+${qualifier}\\b`,
          'i',
        ).exec(text);
        if (alias) {
          table = tables.find(
            (t) => t.toLowerCase() === alias[1].toLowerCase(),
          );
        }
      }
      if (!table) return null;
      return {
        from: { line: context.pos.line, ch: context.pos.ch - dotted[2].length },
        items: schema[table].map((label) => ({
          label,
          kind: 'column',
          detail: table,
          boost: 2,
        })),
      };
    }

    // table position?
    const wantsTable = /\b(from|join|into|update|table)\s+[\w$]*$/i.test(
      before,
    );
    const items: CompletionItem[] = tables.map((label) => ({
      label,
      kind: 'table',
      detail: `${schema[label].length} columns`,
      boost: wantsTable ? 3 : 1,
    }));
    if (!wantsTable) {
      for (const [table, columns] of Object.entries(schema)) {
        for (const column of columns) {
          items.push({ label: column, kind: 'column', detail: table });
        }
      }
    }
    return { items };
  };
}
