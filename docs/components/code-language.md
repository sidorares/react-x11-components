# code-language

```ts
import {
  codeRuns,
  languageForTag,
  tokenizeText,
  streamLanguage,
  sql,
} from '@react-x11/components/code-language';
```

The language seam: tokenizers, the token vocabulary, the built-in languages,
the token palettes and the static-highlighting helpers.
[`<CodeEditor>`](code-editor.md), [`<Code>`](code.md) and
[`<Markdown>`](markdown.md)'s fenced blocks all stand on this.

It **registers nothing** and has no side effect at import time. Importing a
language costs exactly that language.

## The seam

```ts
interface Language {
  name: string;
  data?: LanguageData;
  createTokenizer(host: TokenizerHost): Tokenizer;
}
```

A named **factory** for tokenizers, not a tokenizer: each editor gets its own,
built against a `TokenizerHost` that hands it the document's lines. A
`Tokenizer` is line-state shaped — handed a line and the state the previous
line ended in, it returns that line's tokens and the state it ends in. That
shape is deliberate: it is CodeMirror 5's, it is TextMate's, and it is what
makes a single-line edit re-tokenize one line instead of the document.
`LineEdit` is how the editor tells the tokenizer what changed, so cached
state below the edit survives.

`LanguageData` is the small bag of facts the editor's own verbs read:

```ts
interface LanguageData {
  lineComment?: string; // '--', '#', '//' — enables Ctrl+/
  wordChars?: string; // extra word characters for double-click and Ctrl+arrow
  completions?: readonly string[]; // words for keywordCompletionSource
  indentAfter?: RegExp; // indent one unit deeper after a matching line
}
```

## Built-in languages

Zero dependencies, hand-written stream tokenizers:

```ts
sql(options?); // SqlOptions — dialect keywords, schema-aware
shell();
glsl();
javascript(options?); // JavascriptOptions — { typescript: true } for TS
json();
```

## Writing one

`streamLanguage(mode)` takes a CodeMirror-5-shaped `StreamMode` — a
`startState()` and a `token(stream, state)` — and is about fifty lines for a
real language. `StringStream` is the scanner it hands you.

```ts
const toml = streamLanguage({
  name: 'toml',
  startState: () => ({}),
  token(stream) {
    if (stream.match(/^#.*/)) return 'comment';
    if (stream.match(/^\[[^\]]*\]/)) return 'heading';
    stream.next();
    return null;
  },
});
```

Override `copyState` and `stateEquals` together when the state is not a flat
bag of primitives. `lineModeLanguage(mode)` is the layer underneath, for a
mode that tokenizes a whole line at once rather than through a stream.

## Adapters to the grammar worlds

```ts
lezerLanguage({ name, parser }); // any @lezer/<lang> parser
textMateLanguage({ name, grammar }); // an initialized TextMate grammar
hljsLanguage({ hljs, name }); // highlight.js, by language name or alias
```

None of the three ships with this package — install the one you want.
TextMate grammars come through `vscode-textmate` or shiki's core; their
tokenizer is line-state shaped too, so it drops straight in.
`LezerParserLike`, `TextMateGrammarLike` and `HljsLike` are structural types,
so no version of any of those libraries is pinned by this package.

### highlight.js, for breadth

The built-in tokenizers cover the languages worth writing by hand.
`hljsLanguage` covers the rest — about thirty more in highlight.js's `common`
build, at an accuracy nobody wants to re-derive — which is what a document
full of arbitrary fences needs:

```ts
import hljs from 'highlight.js/lib/common';
import { hljsLanguage } from '@react-x11/components/code-language';

<Markdown resolveLanguage={(tag) => hljsLanguage({ hljs, name: tag })} />;
```

It returns `null` for a name this build of highlight.js does not know, which
is the answer `resolveLanguage` expects — the fence then falls through to the
built-ins and finally to plain text. The app picks the build: `lib/common`,
or `lib/core` plus its own registrations, or the full one.

highlight.js has no incremental mode, so the adapter highlights the whole
document and slices it per line, re-running on edit. That is right for a
fence, a `<Code>` block or a file of a few hundred lines, and wrong for a
megabyte under a caret — put a Lezer grammar behind `<CodeEditor>` there.

`scopeTypes` re-aims a scope (`{ attribute: 'variableName' }`), and `data`
supplies the `lineComment` and friends that highlight.js does not describe.

## Token palettes

```ts
LIGHT_TOKEN_STYLES;
DARK_TOKEN_STYLES;
TOKEN_FALLBACK; // the style an unknown token type gets
tokenStyleFor(type, styles);
autoTokenStyles(background); // picks the palette that will be legible
isDarkBackground(color);
```

`autoTokenStyles` is the one to reach for. Deciding from the actual
background rather than a light/dark flag is what makes a custom theme work
without declaring which it is.

A `TokenStyle` is a colour plus optional weight and italic; a `TokenStyles`
maps `TokenType` to one. Colours may be `'$token'` names, resolved against
the live theme by [`codeblock`](codeblock.md)'s `themeTokenResolver`.

## Static highlighting

```ts
languageForTag('tsx'); // the built-in registry, by fence tag
tokenizeText(source, language); // whole-document tokens, no editor involved
codeRuns(text, tag, opts); // straight to <richtext> runs
```

`codeRuns` is what `<Code>` and `<Markdown>` use, through
[`codeblock`](codeblock.md)'s `codeBlockRuns`. Its `CodeRunOptions` carries
the palette (`styles`), the plain-text `color` for gaps and unstyled tokens,
an optional `resolveToken` for `'$token'` colour names, an explicit
`language` that takes precedence over the tag, and a `resolveLanguage(tag)`
consulted before the built-in registry — the seam `hljsLanguage` goes
through. An empty `tag` with no `language` is how "do not highlight this" is
said.
