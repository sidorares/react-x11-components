# Markdown

```jsx
import { Markdown } from '@react-x11/components/markdown';

<box style={{ overflow: 'scroll', flexGrow: 1 }}>
  <Markdown
    source={streamed}
    partial={stillStreaming}
    onLink={(href) => open(href)}
    style={{ padding: 16 }}
  />
</box>;
```

A GFM renderer built for streamed model output — the
[Streamdown](https://streamdown.ai/) use case, rendered natively. Feed it a
growing `source` and every instant renders clean: unclosed `**bold`,
`` `code `` or a half-arrived `[link](…` never flash their raw markers, an
ambiguous `---` tail is held until it can be read, an open fence is already a
code block. When the stream ends, flip `partial` off and the tail is re-read
under final-document rules.

There is **no markdown→HTML pass anywhere**. The parser is this package's
own, and rendering is `<box>` and [`<richtext>`](richtext.md) composition.
This component replaces core's ntk-backed `<markdown>` element; ntk's
`MarkdownView` and `HtmlView` are being deprecated, and there is deliberately
no `<html>` successor.

## Props

| Prop             | Type                                        | Notes                                                                                            |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `source`         | `string`                                    | The markdown text. Append to it as chunks stream in. Required.                                   |
| `partial`        | `boolean`                                   | Whether more source may still arrive. Default **true** — set it false when the stream ends.      |
| `selectable`     | `boolean`                                   | Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true.                                         |
| `onLink`         | `(href: string, ev: X11MouseEvent) => void` | A link was activated. Absent means clicks do nothing — this component never navigates by itself. |
| `fontSize`       | `number`                                    | Base text size. Default: the theme's (14).                                                       |
| `fontFamily`     | `string`                                    | Default `sans-serif`.                                                                            |
| `monoFamily`     | `string`                                    | Code font. Default `'monospace'` — there is no theme token for it.                               |
| `selectionColor` | `string`                                    | Selection band fill. Default: the theme accent at 35% opacity.                                   |
| `highlight`      | `boolean`                                   | Syntax colouring in fenced code. Default true.                                                   |
| `style`          | `Style \| Style[]`                          | The root box — width, padding, margins, `overflow`.                                              |
| `data-testname`  | `string`                                    | For `react-x11/test` queries.                                                                    |

## What it renders

GFM, parsed by `src/markdown/parse.ts`:

- headings, both ATX (`##`) and setext;
- emphasis through the real CommonMark delimiter-run algorithm, including
  intraword rules and `***both***`;
- inline code spans, hard breaks and entities;
- inline links, `<autolinks>` and bare email autolinks;
- **images as their alt text**, linked to the image source — nothing is
  fetched, ever;
- lists, nested, ordered, bullet and task (`- [x]`), with the tight/loose
  distinction;
- blockquotes, including lazy continuation;
- tables with per-column alignment and measured column widths;
- thematic breaks;
- fenced and indented code, highlighted through the same
  [language seam](code-language.md) `<CodeEditor>` uses, with ntk's
  highlighter as the fallback for tags the built-ins do not cover.

### The deliberate deviations

All of them in the direction streamed model output wants:

- **Streaming tolerance is in the parser, not a repair pre-pass.** One pass
  over the text instead of repair-then-reparse, and none of the "was that
  backtick inside a fence?" re-scans a repair pass needs. The behavioural
  spec is Streamdown's `remend` package — the handlers were read, not
  imported.
- **A single `~` is never strikethrough**, though GFM allows it. `~~` only,
  so `20~25` needs no escaping heuristic.
- **Reference links (`[text][ref]`) stay literal.** They need a definitions
  pass over the whole document, and streamed output essentially never uses
  them.
- **Raw HTML is literal text.** There is no HTML pass anywhere in this
  component, by design. `<Component />` syntax is reserved for the future MDX
  extension.

## Selection is the point

Text selects across every block — drag, double-click a word, triple-click a
block, Ctrl+A, Ctrl+C — and a mouse-up with a selection takes the X11 PRIMARY
selection, so middle-click paste works everywhere.

All of that is core's `selectable` (react-x11#291). What this component adds
is **which parts are chrome**, so copied text is clean: list markers stay
behind, and the separators come from the layout — which for a table is
exactly cells joined with tabs and rows with newlines.

## Streaming

Rendering is cached per top-level block, keyed on the raw source text of that
block, so appending to the tail re-renders the tail alone rather than the
document. That is what makes a token-by-token stream cheap.

`partial` is the difference between "this document is finished" and "more may
arrive". While it is true the live tail is rendered friendly, and constructs
that cannot yet be read are held rather than shown half-formed. It defaults
to true, so the streaming case is the one you get without saying anything.

## The parser is exported

```ts
import { parseMarkdown } from '@react-x11/components/markdown';
import type {
  MarkdownDocument,
  BlockNode,
  InlineNode,
  ParseOptions,
} from '@react-x11/components/markdown';
```

Same parser, same tolerance, no renderer attached — for a table of contents, a
word count, or a second renderer of your own.

## MDX

On the roadmap, not in the box. The AST reserves a `component` node and the
renderer is ordinary React composition, so user components can interleave —
including mid-stream — once the parser learns the syntax. The reserved seam is
the only part that exists today.

## Example

`npm run examples:markdown` streams a document in live, so the partial-render
behaviour is visible rather than described.
