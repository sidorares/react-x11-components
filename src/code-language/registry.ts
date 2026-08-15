// Fence-tag → Language. The names are the ones people actually type after
// three backticks, mapped onto the built-in tokenizers. This is a function
// of a string, not a table of instances, so a bundle pays only for the
// languages the call graph can reach — and it can reach all of them, which
// is the honest cost of highlighting arbitrary fenced code.
import type { Language } from './types.js';
import { glsl } from './languages/glsl.js';
import { javascript } from './languages/javascript.js';
import { json } from './languages/json.js';
import { shell } from './languages/shell.js';
import { sql } from './languages/sql.js';

/**
 * The `Language` for a markdown fence tag (`js`, `tsx`, `bash`, …), or
 * null for a tag nothing here tokenizes. Callers decide what null means:
 * `codeRuns` consults `resolveLanguage` first — `hljsLanguage` is what goes
 * there for breadth — and paints plain text when that answers null too.
 */
export function languageForTag(tag: string): Language | null {
  switch (tag.toLowerCase()) {
    case 'js':
    case 'javascript':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
    case 'typescript':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
    case 'jsonc':
      return json();
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'shell':
    case 'console':
      return shell();
    case 'sql':
      return sql();
    case 'glsl':
      return glsl();
    default:
      return null;
  }
}

/**
 * Run a tokenizer over a whole static text. The editor pulls line by line
 * while painting; a static code block wants everything once — this is that
 * adapter. Returns one token array per line.
 */
export function tokenizeText(
  language: Language,
  text: string,
): ReadonlyArray<ReadonlyArray<{ from: number; to: number; type: string }>> {
  const lines = text.split('\n');
  const tokenizer = language.createTokenizer({ invalidate: () => {} });
  tokenizer.setLines(lines);
  const out = lines.map((_, i) => tokenizer.lineTokens(i));
  tokenizer.dispose?.();
  return out;
}
