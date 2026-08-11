// The TextMate adapter: plug a grammar from the VS Code / Shiki world into
// `<CodeEditor language>`.
//
// TextMate grammars are the largest grammar collection in existence — every
// VS Code language extension ships one — and their tokenizer is *exactly*
// line-state shaped: `tokenizeLine(line, previousState)` returns scoped
// tokens plus the state the next line starts in, which is this editor's
// native model. So the adapter is a scope-name mapping over the same
// line-table engine the built-in modes use — incremental re-tokenization
// and convergence come for free, with `StateStack.equals` as the
// convergence test — and this package depends on none of the TextMate
// machinery. The app brings an initialized grammar:
//
// ```ts
// // via vscode-textmate + vscode-oniguruma, or shiki's core — app policy
// const grammar = await registry.loadGrammar('source.python');
// <CodeEditor language={textMateLanguage({ name: 'python', grammar })} />
// ```
import type { Language, LanguageData, Token } from './types.js';
import { lineModeLanguage } from './stream.js';

/** vscode-textmate's `StateStack`, structurally: opaque, with `equals`. */
export interface TextMateStateLike {
  equals(other: TextMateStateLike): boolean;
}

/** The slice of vscode-textmate's `IGrammar` the adapter calls. */
export interface TextMateGrammarLike {
  tokenizeLine(
    line: string,
    prevState: TextMateStateLike | null,
  ): {
    tokens: Array<{ startIndex: number; endIndex?: number; scopes: string[] }>;
    ruleStack: TextMateStateLike;
  };
}

/**
 * TextMate scope prefix → editor token type, longest dotted prefix wins,
 * most specific scope first. Extend with `scopeStyles` for a grammar that
 * invents its own names.
 */
const DEFAULT_SCOPE_MAP: Readonly<Record<string, string>> = {
  comment: 'comment',
  'comment.block.documentation': 'docComment',
  string: 'string',
  'string.regexp': 'string2',
  'constant.numeric': 'number',
  'constant.language': 'atom',
  'constant.character.escape': 'escape',
  constant: 'atom',
  keyword: 'keyword',
  'keyword.operator': 'operator',
  storage: 'keyword',
  'storage.modifier': 'modifier',
  'entity.name.function': 'function',
  'entity.name.type': 'typeName',
  'entity.name.class': 'className',
  'entity.name.namespace': 'namespace',
  'entity.name.tag': 'typeName',
  'entity.other.attribute-name': 'propertyName',
  'support.function': 'function',
  'support.type': 'typeName',
  'support.class': 'className',
  'support.constant': 'atom',
  variable: 'variableName',
  'variable.other.property': 'propertyName',
  'punctuation.definition.comment': 'comment',
  'punctuation.definition.string': 'string',
  punctuation: 'punctuation',
  'meta.preprocessor': 'meta',
  invalid: 'invalid',
};

export interface TextMateLanguageOptions {
  name: string;
  grammar: TextMateGrammarLike;
  data?: LanguageData;
  /** Extra scope-prefix → token-type entries, consulted before the
   * defaults. */
  scopeStyles?: Readonly<Record<string, string>>;
}

function mapScopes(
  scopes: readonly string[],
  extra: Readonly<Record<string, string>> | undefined,
): string | null {
  // the most specific scope is last; walk backwards and take the first
  // (longest-prefix) mapping that answers
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    for (let cut = scope.length; cut > 0;) {
      const prefix = scope.slice(0, cut);
      const mapped = extra?.[prefix] ?? DEFAULT_SCOPE_MAP[prefix];
      if (mapped) return mapped;
      cut = prefix.lastIndexOf('.');
    }
  }
  return null;
}

/** Wrap an initialized TextMate grammar as a {@link Language}. */
export function textMateLanguage(options: TextMateLanguageOptions): Language {
  interface S {
    stack: TextMateStateLike | null;
  }
  return lineModeLanguage<S>({
    name: options.name,
    languageData: options.data,
    startState: () => ({ stack: null }),
    copyState: (s) => ({ stack: s.stack }),
    stateEquals: (a, b) =>
      a.stack === b.stack ||
      (a.stack != null && b.stack != null && a.stack.equals(b.stack)),
    runLine(line: string, state: S): Token[] {
      const result = options.grammar.tokenizeLine(line, state.stack);
      state.stack = result.ruleStack;
      const out: Token[] = [];
      const tokens = result.tokens;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const from = t.startIndex;
        const to = t.endIndex ?? tokens[i + 1]?.startIndex ?? line.length;
        if (to <= from) continue;
        const type = mapScopes(t.scopes, options.scopeStyles);
        if (!type) continue;
        const last = out[out.length - 1];
        if (last && last.to === from && last.type === type) last.to = to;
        else out.push({ from, to, type });
      }
      return out;
    },
  });
}
