# Code

```jsx
import { Code } from '@react-x11/components/code';

<Code source={snippet} lang="ts" lineNumbers />;
```

The static sibling of [`<CodeEditor>`](code-editor.md): a read-only,
selectable code block for _showing_ code rather than editing it.

It is composition, not a new element — a `<box selectable>` over
[`<richtext>`](richtext.md) lines, highlighted through
[`code-language`](code-language.md) and painted with the palette and chrome
in [`codeblock`](codeblock.md). Those are the same three pieces
[`<Markdown>`](markdown.md)'s fenced blocks use, which is why the two agree
inside one window.

## Props

| Prop              | Type                        | Notes                                                                                                                             |
| ----------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `source`          | `string`                    | The code, verbatim. Required.                                                                                                     |
| `lang`            | `string`                    | A fence-style tag — `'js'`, `'tsx'`, `'bash'`, `'sql'`. A tag `resolveLanguage` and the built-ins both decline paints plain.      |
| `language`        | `Language`                  | An explicit language (a Lezer or TextMate adapter, say). Takes precedence over `lang`.                                            |
| `resolveLanguage` | `(tag) => Language \| null` | A `Language` for a `lang` the built-ins do not cover — [`hljsLanguage`](code-language.md#highlightjs-for-breadth) goes here.      |
| `lineNumbers`     | `boolean`                   | A gutter. Ignored when `wrap` is on — a wrapped source line would put the numbering out of register.                              |
| `wrap`            | `boolean`                   | Wrap long lines instead of scrolling horizontally. Default false.                                                                 |
| `selectable`      | `boolean`                   | Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true.                                                                          |
| `fontSize`        | `number`                    | Default: 0.9 × the theme `fontSize`, matching `<Markdown>`'s blocks.                                                              |
| `monoFamily`      | `string`                    | Default `'monospace'` — there is no theme token for it.                                                                           |
| `tokenStyles`     | `TokenStyles`               | Palette override. The default follows the theme background, and `'$token'` colours in a custom palette resolve against the theme. |
| `selectionColor`  | `string`                    | Selection band fill. Default: the theme accent at 35% opacity.                                                                    |
| `style`           | `Style \| Style[]`          | The root box — width, margins, `flexGrow`.                                                                                        |
| `data-testname`   | `string`                    | For `react-x11/test` queries.                                                                                                     |

## Copied code pastes clean

Selection is **core's** (react-x11#291): a `<box selectable>` is a surface,
everything under it that answers for its own text joins the selection, and
the drag, the granularities, Ctrl+A, Ctrl+C and PRIMARY come with it. What
this component adds is saying which parts are chrome — the line-number gutter
is `selectable={false}`, so a copied selection is the code and only the code,
with no numbers pasted down the left margin.

## Highlighting

Three ways in, in precedence order:

1. `language={…}` — anything the [language seam](code-language.md) accepts:
   a built-in (`sql()`, `shell()`, `glsl()`, `javascript()`, `json()`), a
   `lezerLanguage({ name, parser })`, a `textMateLanguage({ name, grammar })`,
   or your own `streamLanguage(…)`.
2. `lang="…"` — the tag, looked up in the built-in registry.
3. Neither, or an unknown tag — ntk's own highlighter when it is present,
   then plain text.

Nothing is ever fetched and nothing is registered globally: importing a
language costs exactly that language.

## Example

`npm run examples:code` renders several blocks with different tags in one
window.
