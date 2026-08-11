// The language seam, as its own module: tokenizers, the token vocabulary,
// the built-in languages, the token palettes, and the static-highlighting
// helpers. `<CodeEditor>`, `<Code>` and `<Markdown>`'s fenced blocks all
// stand on this — it is the "shared module that both import" the
// tree-shaking rules call for, and it registers nothing: importing a
// language costs exactly that language.
export { lineModeLanguage, streamLanguage, StringStream } from './stream.js';
export type { LineMode, StreamMode } from './stream.js';

export { glsl } from './languages/glsl.js';
export { javascript } from './languages/javascript.js';
export type { JavascriptOptions } from './languages/javascript.js';
export { json } from './languages/json.js';
export { shell } from './languages/shell.js';
export { sql } from './languages/sql.js';
export type { SqlOptions } from './languages/sql.js';

export { lezerLanguage } from './lezer.js';
export type { LezerLanguageOptions, LezerParserLike } from './lezer.js';
export { textMateLanguage } from './textmate.js';
export type {
  TextMateGrammarLike,
  TextMateLanguageOptions,
} from './textmate.js';

export {
  autoTokenStyles,
  DARK_TOKEN_STYLES,
  isDarkBackground,
  LIGHT_TOKEN_STYLES,
  tokenStyleFor,
} from './theme.js';

export { languageForTag, tokenizeText } from './registry.js';
export { codeRuns } from './runs.js';
export type { CodeRun, CodeRunOptions } from './runs.js';

export { TOKEN_FALLBACK } from './types.js';
export type {
  Language,
  LanguageData,
  LineEdit,
  Token,
  Tokenizer,
  TokenizerHost,
  TokenStyle,
  TokenStyles,
  TokenType,
} from './types.js';
