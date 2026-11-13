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

| Prop              | Type                                          | Notes                                                                                                                                                                          |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`          | `string`                                      | The markdown text. Append to it as chunks stream in. Required.                                                                                                                 |
| `partial`         | `boolean`                                     | Whether more source may still arrive. Default **true** — set it false when the stream ends.                                                                                    |
| `selectable`      | `boolean`                                     | Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true.                                                                                                                       |
| `onLink`          | `(href: string, ev: X11MouseEvent) => void`   | A link was activated. Absent means clicks do nothing — this component never navigates by itself.                                                                               |
| `links`           | `LinkKinds`                                   | Kinds of link the document knows — what a click on one does and the card a resting pointer opens over it. See "Links to things" below. Needs a stable identity, like `fences`. |
| `fontSize`        | `number`                                      | Base text size. Default: the theme's (14).                                                                                                                                     |
| `fontFamily`      | `string`                                      | Default: the theme's `fontFamily`.                                                                                                                                             |
| `lineHeight`      | `number`                                      | Body text's line height — paragraphs, list items, quotes, table cells — as a multiple of the font's own line. Default **1.4**; 1 is the font's own. See "Type and spacing".    |
| `codeFontSize`    | `number`                                      | Fenced code's size. Default: 0.9 × `fontSize`.                                                                                                                                 |
| `codeLineHeight`  | `number`                                      | Fenced code's line height, a multiple of the mono font's own line. Default 1.4, as `<Code>`'s.                                                                                 |
| `monoFamily`      | `string`                                      | Code font, inline and fenced. Default: the theme's `monoFamily`.                                                                                                               |
| `selectionColor`  | `string`                                      | Selection band fill. Default: the theme accent at 35% opacity.                                                                                                                 |
| `highlight`       | `boolean`                                     | Syntax colouring in fenced code. Default true.                                                                                                                                 |
| `resolveLanguage` | `(tag) => Language \| null`                   | A `Language` for a fence tag the built-ins do not cover — [`hljsLanguage`](code-language.md#highlightjs-for-breadth) goes here. Needs a stable identity, like `fences`.        |
| `fences`          | `Record<string, (f: FenceInfo) => ReactNode>` | Custom renderers for fenced blocks, by language — see "Custom fences" below.                                                                                                   |
| `styles`          | `MarkdownStyles`                              | Style over the parts of the document — `paragraph`, `heading`, `quote`, `code`, a link's hover `card` — merged over each part's own. Needs a stable identity, like `fences`.   |
| `style`           | `Style \| Style[]`                            | The root box — width, padding, margins, `overflow`.                                                                                                                            |
| `data-testname`   | `string`                                      | For `react-x11/test` queries.                                                                                                                                                  |

## Type and spacing

A numeric line height here is what a `<text>`'s is: a **multiple of the
font's own line**, its ascent and descent, not of the font size as in CSS.
At 14px in SF the font's own line is 16.5px, so the default 1.4 is about
23px — CSS's 1.65. The leading it adds is shared above and below the letters,
which is where list numbers, bullets and task checkboxes are placed from: on
the first line's letters, at any size and line height. Headings keep the
font's own line unless `styles.heading` gives them one.

A fence is a [code block](codeblock.md), with the block's defaults in ems of
the code's own size, so a block at a larger size keeps its proportions:
padding 1em, corner radius 0.7em, and 1.5em of space above and below it
among prose — none at the start or end of the document.

`styles` reaches the parts by name, over their own style:

```jsx
const styles = {
  paragraph: { marginBottom: 4 },
  heading: { lineHeight: 1.2 },
  quote: { borderLeftColor: '$accent' },
  code: { borderWidth: 1, borderColor: '$border', marginTop: 0 },
};

<Markdown source={text} lineHeight={1.5} styles={styles} />;
```

`paragraph` and `heading` style the text block — its line height, margins
and alignment — not its runs' size or colour, which the font props and the
theme set. `quote` is the quote's box and `code` a fence's.

`npm run examples:type-lab` puts sliders on all of it over a sample chat.

## What it renders

GFM, parsed by `src/internal/markdown/parse.ts`:

- headings, both ATX (`##`) and setext;
- emphasis through the real CommonMark delimiter-run algorithm, including
  intraword rules and `***both***`;
- inline code spans, hard breaks and entities; a tab in running text or a
  code span is set as the space it reads as, as HTML sets one, and one in a
  fenced or indented code block goes to its stop, every eight spaces;
- inline links, `<autolinks>` and bare email autolinks;
- **images as their alt text**, linked to the image source — nothing is
  fetched, ever;
- lists, nested, ordered, bullet and task (`- [x]`), with the tight/loose
  distinction;
- blockquotes, including lazy continuation;
- tables with per-column alignment and measured column widths — a table
  that streams measures and lays out the rows it gains, and keeps the rest;
- thematic breaks;
- fenced and indented code, highlighted through the same
  [language seam](code-language.md) `<CodeEditor>` uses; `resolveLanguage`
  is where tags the built-ins do not cover come from. A block does not wrap:
  a line longer than the block scrolls inside it. A long one is drawn a
  block of lines at a time, as [`<Code>`](code.md#a-long-source-is-drawn-in-blocks)
  is, so a fence that streams lays out the lines it gains rather than
  itself.

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

## Links to things

A link in a reply often names a _thing_ — a pull request, another agent
session, a ticket — whose state matters more than its address: are the
checks green, is the session still running. `links` is a list of kinds that
recognise such hrefs, and each says what a click does and what card opens
when the pointer rests on the link.

```tsx
import { Markdown, linkKind } from '@react-x11/components/markdown';

const pullRequest = linkKind({
  match: (href) =>
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(href),
  card: (m) => <PullRequestCard repo={m[1]} number={Number(m[2])} />,
});
const session = linkKind({
  match: (href) => sessionIdOf(href), // null for an href that is not one
  activate: (id) => openSession(id),
  card: (id, { text }) => <SessionCard id={id} title={text} />,
});
const LINKS = [pullRequest, session]; // module scope: a stable identity

<Markdown source={reply} links={LINKS} onLink={openInBrowser} />;
```

**The document holds which thing, never its state.** A link stays an
ordinary markdown link — `[#1476](https://github.com/o/r/pull/1476)` — so
the text reads and works in any other renderer, copies as markdown, and is
something a model writes without being taught a syntax. Write the href as
the thing's real address where it has one: a pull request's URL, the deep
link an app opens a session with. A kind then recognises links nobody marked
as special, a bare PR URL a model pasted among them. State changes after the
document was written, so it is the card's to read: the card is the
application's own component, mounted while the card is up and subscribed to
the application's own stores, and a change re-renders the card and nothing
in the document.

How the parts behave:

- **`match(href)`** reads a reference out of an href, or answers `null`.
  The kinds are tried in order and the first that matches has the link.
  `linkKind` infers the reference's type from `match`, so `activate` and
  `card` are checked against it.
- **`activate(ref, link, ev)`** takes the click. A kind without one leaves
  the click to `onLink`, so a kind can add a card to links the application
  already follows. A link no kind activates and no `onLink` takes is inert,
  as before.
- **`card(ref, ctx)`** is drawn in a `<popup>` hung below the piece of the
  link under the pointer, after `cardDelay` (default 400 ms) of rest. It
  stays up while the pointer is on the link or on the card, and goes 250 ms
  after it is on neither, at a press anywhere in the document, or at Escape
  while the document has the focus. `ctx.text` is the link's whole label,
  across its runs and lines; `ctx.close()` takes the card down. A press is
  never a hover: a drag that selects across a link opens nothing.
- The frame — fill, border, radius, padding — is the theme's surface, and
  `styles.card` goes over it.
- The pointer cursor shows over a link where a click on it does something:
  with `onLink`, or with a kind that activates. With cards alone a link keeps
  the text's cursor.

The card's `text` is everything the document draws for the link, so a link
written `[the **parser** fix](…)` hands over `the parser fix`. Two links to
one address written side by side read as one link: the element knows runs
by their `href` and nothing else.

## Custom fences

A fenced block whose language has an entry in `fences` renders through it
instead of as a code block:

```jsx
import { Formula } from '@react-x11/components/formula';
import { Mermaid } from '@react-x11/components/mermaid';

const FENCES = {
  math: ({ text, partial }) => <Formula tex={text} display partial={partial} />,
  mermaid: ({ text, partial }) => <Mermaid source={text} partial={partial} />,
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
make the fence's component its own selection surface (`<Formula>` and
[`<Mermaid>`](mermaid.md) inside a document stay `selectable={false}`, the
default).

Two things to hold: the map's identity is an epoch for the block cache, so
define it at module scope (or memoize) rather than inline in JSX; and the
key is matched against the fence's info string lowercased, first word only
(` ```Math title` looks up `math`).

## Streaming

Rendering is cached per top-level block, keyed on the raw source text of that
block, so appending to the tail re-renders the tail alone rather than the
document. That is what makes a token-by-token stream cheap.

A block also keeps its place in the tree from one render to the next. The new
blocks are matched to the old ones from both ends, so the blocks a change
left alone keep their nodes, and a block that changed is updated in place. A
paragraph inserted into the middle of a 600 KB report reaches the screen in
31 ms. When blocks were keyed by their index it took 958 ms, because every
block after the insertion moved onto another block's key and was rendered
and laid out again.

The parse is not repeated whole either. Each new `source` is parsed as an
edit of the one before (`ParseOptions.previous`). The parse starts at the
block before the first line that changed and stops once it stands where the
previous parse stood, among the lines the change left alone. Measured on
X11 in production:

- A 200-character chunk at the end of a 190 KB stream parses in 0.26 ms,
  down from 8.1 ms for the whole document.
- An edit to one paragraph of a 600 KB report parses in about 1 ms, down
  from 23–27 ms. From the edit to the screen it went from 54 to 32 ms, and
  an append from 70–82 to 45 ms.

The result is always what a parse from scratch gives: a fence opened
mid-document still swallows the rest. With `components`, every change parses
the whole document again, because an open tag looks for its closing tag as
far as the end of the document.

`partial` is the difference between "this document is finished" and "more may
arrive". While it is true the live tail is rendered friendly, and constructs
that cannot yet be read are held rather than shown half-formed. It defaults
to true, so the streaming case is the one you get without saying anything.

## A long document

Every box in a document is laid out, measured for its floors and
absolutized again whenever the width changes, so the renderer makes as few
as the document allows. An item that is one paragraph is that paragraph,
laid out in the row beside its marker; the marker is a `<text>` of its own;
and a table cell is its text, with the padding as margins, since the row
paints the background and a cell has nothing else to draw. A multi-block
item keeps its column, for the gap between its blocks. The pixels are the
same as the boxes' were.

A 600 KB report is 10,188 nodes where it was 14,717. A step of a window
resize went from 332 to 275 ms on macOS and from 256 to 205 ms on XQuartz,
and the first paint from 1,230 to 1,050 ms and from 990 to 820 ms.

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

To parse a changed source, pass the document its previous version parsed into:
`parseMarkdown(next, { partial, previous: doc })`. Only the blocks around the
change are parsed again, and the rest are the same objects as before. That
is what `<Markdown>` does with its `source`.

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
