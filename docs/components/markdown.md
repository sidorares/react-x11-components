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

| Prop              | Type                                          | Notes                                                                                                                                                                   |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`          | `string`                                      | The markdown text. Append to it as chunks stream in. Required.                                                                                                          |
| `partial`         | `boolean`                                     | Whether more source may still arrive. Default **true** — set it false when the stream ends.                                                                             |
| `selectable`      | `boolean`                                     | Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true.                                                                                                                |
| `onLink`          | `(href: string, ev: X11MouseEvent) => void`   | A link was activated. Absent means clicks do nothing — this component never navigates by itself.                                                                        |
| `fontSize`        | `number`                                      | Base text size. Default: the theme's (14).                                                                                                                              |
| `fontFamily`      | `string`                                      | Default `sans-serif`.                                                                                                                                                   |
| `monoFamily`      | `string`                                      | Code font. Default `'monospace'` — there is no theme token for it.                                                                                                      |
| `selectionColor`  | `string`                                      | Selection band fill. Default: the theme accent at 35% opacity.                                                                                                          |
| `highlight`       | `boolean`                                     | Syntax colouring in fenced code. Default true.                                                                                                                          |
| `resolveLanguage` | `(tag) => Language \| null`                   | A `Language` for a fence tag the built-ins do not cover — [`hljsLanguage`](code-language.md#highlightjs-for-breadth) goes here. Needs a stable identity, like `fences`. |
| `fences`          | `Record<string, (f: FenceInfo) => ReactNode>` | Custom renderers for fenced blocks, by language — see "Custom fences" below.                                                                                            |
| `style`           | `Style \| Style[]`                            | The root box — width, padding, margins, `overflow`.                                                                                                                     |
| `data-testname`   | `string`                                      | For `react-x11/test` queries.                                                                                                                                           |

## What it renders

GFM, parsed by `src/internal/markdown/parse.ts`:

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
  [language seam](code-language.md) `<CodeEditor>` uses; `resolveLanguage`
  is where tags the built-ins do not cover come from.

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

## Custom fences

A fenced block whose language has an entry in `fences` renders through it
instead of as a code block:

```jsx
import { Formula } from '@react-x11/components/formula';

const FENCES = {
  math: ({ text, partial }) => <Formula tex={text} display partial={partial} />,
};

<Markdown source={doc} partial={streaming} fences={FENCES} />;
```

The renderer gets `{ lang, text, partial }` — `partial` is true while the
fence is the live tail of a streaming document and its text is still
growing. The seam is a map so this component never imports the components
it hosts (the no-lateral-imports rule); the returned element lands in a
keyed slot, so it needs no `key` of its own. Whatever it returns joins the
document's selection if it answers core's text accessors, which core's own
elements and everything in this package already do — so **do not** also
make the fence's component its own selection surface (`<Formula>` inside a
document stays `selectable={false}`, the default).

Two things to hold: the map's identity is an epoch for the block cache, so
define it at module scope (or memoize) rather than inline in JSX; and the
key is matched against the fence's info string lowercased, first word only
(` ```Math title` looks up `math`).

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

Components in the prose, in block position, resolved from a map:

```tsx
<Markdown source={doc} components={{ Chart, Callout }} />
```

```markdown
Revenue recovered in the second half:

<Chart data={[12, 40, 38]} height={240} />

<Callout tone="warn">

Children are markdown, so a callout can hold a heading and a list.

</Callout>
```

**A tag is a component iff its name is a key in `components`.** There is no
capitalisation rule and no HTML fallback, so `<Chart/>` in a document with no
`Chart` key is the literal text it has always been — and a document that
never passes the prop parses exactly as it did before the feature existed.
That gate is why turning MDX on cannot change anything you already render.

**Nothing is evaluated.** An attribute is a string, `true` for a bare name,
or the `JSON.parse` of a `{…}`. A brace that is not JSON makes the tag
unreadable and it stays text. Since this component's usual input is streamed
model output, that is the property that matters: a document from a stranger
can name a component you already decided to expose, and hand it JSON, and
that is all.

A dotted name resolves flat first (`components['Card.Header']`), then by
walking (`components.Card.Header`), so compound components work.

A tag may span several lines, which is how a component with six props is
written. It may not span a blank line.

While streaming, a tag still arriving is held back rather than shown as
syntax, like every other half-arrived construct; an element whose children
are still arriving shows those children as the markdown they are, and
becomes a component on the chunk that closes it.

### Expressions

`scope` is the second rung, and the prop that says this document may **run
code**:

```tsx
<Markdown source={doc} components={{ Chart }} scope={{ quarters }} />
```

With it, three things start working, all in the same syntax:

```markdown
<Chart data={quarters.map(Number)} {...defaults} />

There are {quarters.length} of them.
```

An attribute `{…}` that is not JSON is compiled instead of making the tag
text; `{...spread}` merges, at the position it was written, so a spread after
`height` overrides it and one before does not; and a brace in the prose
renders its value. Without `scope`, none of those exist and nothing is ever
compiled — an attribute must be JSON and a brace in a paragraph is a brace.

**There is no sandbox.** Expressions run through `new Function`, in this
process, with this process's authority. `components` decides what a document
may _reach_; `scope` decides whether it may _compute_. Since the usual input
here is streamed model output, the rule is short: do not pass `scope`
alongside a document you did not write. A model told what components exist
will emit tags; one that has been prompt-injected will emit expressions.

An expression that throws, or does not compile, renders as nothing and warns
once — a document being typed is full of expressions that do not work yet. A
value that is not a primitive also renders as nothing in prose, because there
is nowhere in a line of text to put an element.

### Block position only

A tag on its own line is a component. One in the middle of a sentence —
`<Badge>Q3</Badge>` — is still text. That is not an oversight: a paragraph
is laid out as a single `<richtext>`, and a `TextRun` has no way to reserve
advance width for an element someone else paints, so an inline component
cannot join the text flow without new machinery. See
[the PRD](../prd-mdx.md), "The inline half".

`import` and `export` are not here and are not planned: resolving a specifier
is a bundler's job, and `components` is the substitute — a better one, since
the application decides what a document may reach. `docs/prd-mdx.md` has the
ladder.

`npm run examples:mdx` shows a document streaming in with and without the
`components` prop, side by side.

## Example

`npm run examples:markdown` streams a document in live, so the partial-render
behaviour is visible rather than described.
