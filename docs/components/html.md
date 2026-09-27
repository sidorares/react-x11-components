# Html

A static HTML + CSS document, rendered into a react-x11 window: selectable
text, real widgets for form controls, and seams for everything that would
otherwise reach the outside world.

```jsx
import { Html } from '@react-x11/components/html';

<box style={{ overflow: 'scroll', flexGrow: 1 }}>
  <Html
    source={html}
    partial={false}
    onLink={(href) => openInBrowser(href)}
    onResource={(r) => (r.kind === 'image' ? readImage(r.url) : null)}
  />
</box>;
```

It registers one host element, `<htmlview>`, which owns the whole pipeline —
parse, cascade, box tree, layout, paint — and draws the document itself. The
form controls are the exception: those are core widgets mounted beside it.

Nothing here fetches or executes anything. See [The seams](#the-seams).

## Props

| Prop              | Type                                             | What it does                                                                                                                                                                 |
| ----------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`          | `string`                                         | The HTML. Required.                                                                                                                                                          |
| `partial`         | `boolean`                                        | Whether more source may still arrive. Default true. While true, a `source` that extends the last one is written to the open parser as a delta — see [Streaming](#streaming). |
| `selectable`      | `boolean`                                        | Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true.                                                                                                                     |
| `stylesheet`      | `string \| string[]`                             | Author stylesheets applied after the document's own, so a host can restyle a document it does not control.                                                                   |
| `charset`         | `string`                                         | The encoding the host decoded `source` from, as a label (`'shift_jis'`). A stylesheet handed over as bytes that names no encoding of its own is in it. Default UTF-8.        |
| `onResource`      | `(r: ResourceRequest) => ResourceResult \| null` | An `<img>`, a `<link rel=stylesheet>` or an `@import` wants loading. May return a promise. **Absent, nothing loads.**                                                        |
| `onScript`        | `(s: ScriptRequest) => void`                     | A `<script>` was found, handed over unparsed and unevaluated.                                                                                                                |
| `onLink`          | `(href, ev) => void`                             | A link was activated. Absent, clicks do nothing — this never navigates by itself.                                                                                            |
| `onDocument`      | `(document: Document) => void`                   | The parsed DOM, each time it is re-parsed.                                                                                                                                   |
| `onControlChange` | `(element, value) => void`                       | A form control changed. The element is the one in the DOM.                                                                                                                   |
| `fontSize`        | `number`                                         | Base text size. Default: theme `fontSize`, or 14.                                                                                                                            |
| `fontFamily`      | `string`                                         | Default `'sans-serif'`.                                                                                                                                                      |
| `monoFamily`      | `string`                                         | Code font. Default `'monospace'` — there is no theme token for it.                                                                                                           |
| `selectionColor`  | `string`                                         | Selection band fill. Default: theme accent at 35% opacity.                                                                                                                   |
| `style`           | `Style \| Style[]`                               | The root `<box>`'s style.                                                                                                                                                    |

## The handle

`useHtmlHandle()` returns a `ref` to pass to `<Html>` plus the document:

```jsx
const handle = useHtmlHandle();

<Html source={html} ref={handle.ref} />;

// later
const links =
  handle.document && DomUtils.getElementsByTagName('a', handle.document);
links[0].attribs.href = '#changed';
handle.refresh();
```

| Member            | What it is                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `document`        | The live DOM — [domhandler]'s tree, which [domutils] speaks natively.                                    |
| `refresh()`       | The DOM changed: restyle, re-lay-out, repaint.                                                           |
| `elementAt(x, y)` | The element under a point, in the window's logical coordinates — the ones a mouse event's `x`/`y` carry. |
| `title`           | The document's `<title>`, if it had one.                                                                 |

`refresh()` is explicit rather than observed, and that is a decision — see
[Manipulating the DOM](#manipulating-the-dom).

## The seams

**`onResource` is the only way anything loads.** This component has no
network client and no filesystem access; it does not resolve URLs against a
base, because it has no base and the host does. The request names the URL as
the document wrote it, what kind of thing it is, and the element that asked:

```jsx
onResource={async (request) => {
  if (!allowed(request.url)) return null;
  if (request.kind === 'stylesheet') {
    return { kind: 'stylesheet', text: await readText(request.url) };
  }
  return { kind: 'image', bytes: await readBytes(request.url) };
}}
```

Image bytes may be PNG, JPEG or SVG; nothing names the type, so an SVG is
told apart by its markup. Return `{ kind: 'image', image, width, height }`
instead to hand over an image the host decoded itself. A declined or absent
resource is an ordinary state: images draw as a frame at their attribute
size, an `<object>` shows its fallback content, and linked stylesheets are
skipped.

A stylesheet may be handed over as bytes instead, with the charset the
protocol named if it named one: `{ kind: 'stylesheet', bytes, charset }`.
It is then decoded the way CSS says (CSS 2.1 4.4, CSS Syntax 3 3.2). A byte
order mark decides first. Then comes the charset handed over, then an
`@charset` rule at the very start of the bytes, then what the referrer says,
then UTF-8. The referrer is a `<link charset>` and the `charset` prop for a
linked sheet, and the importing sheet's encoding for an `@import`. A host
that decodes its stylesheets itself hands over text and is not second-guessed.

**`onScript` never runs anything.** It is handed the `type`, the `src`, the
element and its text verbatim, and nothing in this package reads any of it —
there is no parser, no sandbox and no partial evaluation, because a renderer
that half-runs a script is one nobody can reason about. An application that
wants scripting brings its own engine, and drives the result through the DOM
handle.

Inline event attributes (`onclick="…"`) are likewise left in the DOM as
attributes and never invoked.

## What renders

The subset is aimed at documents an application is handed — mail, release
notes, help pages, exported reports, generated summaries — rather than at the
open web. How much of CSS 2.1 that comes to, measured against the W3C's own
test suite on both backends, is in
[`<Html>` against the CSS 2.1 test suite](../html-conformance.md).

**Layout:** block flow with margin collapsing, inline formatting with
bidi and full shaping, `inline-block`, floats and `clear`, lists with their
markers, tables (the auto algorithm and `table-layout: fixed`, with `colspan`
and `rowspan`, and the anonymous table CSS builds around table parts that
have none), `position: relative | absolute | fixed`, `display: flex`, and
`display: grid` as documents write it (below). An
inline-block sits on its last line's baseline and an inline-table on its
first row's. A relatively positioned inline box moves its text, its
background and borders and any block inside it, and leaves its lines where
they were, which is how Tailwind's preflight and normalize.css raise a
`<sup>`; a paragraph with one is laid out a line at a time, as one with an
inline-block is.
A flex container is laid out by Yoga, the engine react-x11 lays itself out
with, and each item by this one: an item of `width: auto` is as wide as its
content, its max-content width, before the row grows or shrinks it, its
padding and border counted once, and a width, height or basis of its own is
its content box's unless `box-sizing` says otherwise. An `auto` margin takes
the free space on its side, so `margin-left: auto` puts an item at the end
of its row. A row of flex items inside another item is as wide as its items
side by side. Items meet where
they meet, fractions of a pixel included, and the paint snaps their edges.
A grid (CSS Grid 1) takes its column tracks from `grid-template-columns` —
lengths, percentages, `fr`s, `auto`, `minmax()`, and `repeat()` by a count
or by what fits, `auto-fill` and `auto-fit` alike — and places its items by
line or span, or in order into the first cells free; a row is as tall as
what is in it, or as the row the template names, and an item is stretched
to its area or aligned in it by `justify-self` and `align-self`. Named
lines and areas, `dense` and column-first placement, and subgrids are not
read.
A table's borders collapse where it asks: one border along each edge of its
grid, centred on it, chosen from the cells, rows, row groups, columns,
column groups and the table that meet there as CSS 2.1 17.6.2.1 chooses —
`hidden` first, then the widest, then the style, then the box. A caption is
outside the table's border, above it or below it by `caption-side`, and an
auto table is at least as wide as its caption's longest word. A header
group's rows are drawn first and a footer group's last, wherever they stand
in the markup, and a cell's background fills its row whatever
`vertical-align` does with its content. A fixed table takes its columns'
widths from its `<col>`s, then from its first row's cells, border box and
all, and shares what is left among the rest (CSS 2.1 17.5.2.1); with
`width: auto` it is laid out by its content, as the section says, where a
column's `width` counts as its cells' do, and a column group's is spread
over its columns (17.5.2.2). A column's or a column group's background is
painted under the cells that start in it, its image placed in the box those
cells make, `border-spacing` takes a length for the rows as well as the
columns, and a
table's `width` includes its borders, as HTML's rendering rules give every
table `box-sizing: border-box`. Table cells in an inline box are an inline
table, with the spaces either side of them kept. A table right to left —
by `direction`, or HTML's `dir`, which is read as it — has its first column
at the right.
A block in an inline element breaks it (CSS 2.1 9.2.1.1): the pieces of the
element before and after the block are on lines of their own, without an
edge where the block cut them, and the block stands between them as a
block, so `<font>` around paragraphs, or a link around a card, keeps its
blocks stacked.
A block that makes a formatting context of its own — `overflow` other than
`visible`, a table, `display: flow-root` — holds its floats and sits beside
another block's rather than under them, its margins its containing
block's: a column with `overflow: hidden` and a 220px margin beside a
200px sidebar starts 220px in, the margin overlapping the float, and one
the floats leave too little room for goes below them.
A line with an inline-block or a padded element on it is put in visual order
a piece at a time — the text engine orders the text inside each piece, and
the line orders the pieces (UAX #9's L2) — so a right-to-left paragraph with
an image in it reads right to left, and it is aligned whole: a centred line
is centred with its images, not text first and the image after it.

**Boxes:** `width`/`height` with `min-`/`max-`, `margin` (a negative one
on an inline box takes its room back from the line), `padding`,
`border` (width, style, colour, radius), `box-sizing`, `overflow`, `clip`,
`opacity`, `visibility` — a hidden element keeps its room and draws
nothing, its text included, and a visible element inside it is drawn —
`z-index`: a positioned box with a negative
`z-index` is painted under the flow of its stacking context, the root
element or a positioned box with a `z-index` of its own, and over that
context's background (CSS 2.1 Appendix E). An absolute box with both
offsets on an axis fills what they leave, or, with a width, shares it
between its `auto` margins, which is how `margin: auto` centres one. A box
is painted with each edge on the pixel it falls nearest, as browsers snap
one, so a rule `1pt` wide is a pixel and boxes that meet at a fraction of a
pixel share the column between them. A corner's radius is a length or a
percentage — of the box's width across and its height down, so `50%` is a
circle on a square box and an ellipse on any other — and a `/` gives the
corners vertical radii of their own; radii too large for their box are
reduced together, so `calc(infinity * 1px)`, Tailwind 4's `rounded-full`,
is a pill. A rounded box's border is a ring rounded on both its edges, the
inside by each radius less the border across it, where every side that has
one has it in one colour and a solid rule: a card's, a button's, and an
accent down one side, which curves into the corners it meets; a rounded
box with sides of different colours has them drawn straight. An image is
trimmed to the corners too — an `<img>` to the curve of its content edge,
so an avatar is a round photograph, and a background to its box's — at the
cost on X11 of a clip the size of the window, which only a rounded box
pays. A box whose `overflow` is not `visible`
clips what it holds to its padding box, rounded where the box is — all of
it but a positioned box whose containing block is outside — and `scroll`
and `auto` clip the same, with no scroll bars: the element around the
document is what scrolls. A table clips to its table box, with its
captions outside the clip. `clip` shows the part of an absolutely positioned
box it names. Inline elements have all of it but the
sizes: an inline box's padding, border and margin take room on its line —
the start side before its first fragment, the end side after its last, on
the sides its `direction` says (CSS 2.1 8.6) — and its background and border
are painted a fragment a line, over its face's height plus its vertical
padding, which is why they do not make the line taller. Where it wraps it is
sliced: no border and no rounded corner on a side it goes on from. A padded
`<a>` set as an email's button, a pill badge and a `<kbd>` keycap render as
a browser renders them.

As in a browser, `display: none` is all that hides `<head>`, `<title>`,
`<style>` and `<script>`: a stylesheet that shows them shows them. What the
markup leaves outside a `<head>`, at the top of the document, is in the
head a browser implies, and stays hidden.

**Replaced content:** an image is sized by its style and what it has of
an intrinsic width, height and ratio (CSS 2.1 10.3.2, 10.6.2), and a
`min-`/`max-` limit on one axis carries to the other through its ratio — an
`<img width="600" style="max-width: 100%">` in a narrow column is scaled,
not squashed (10.4). An `<object>` whose `data` is an image shows it, and
its fallback content until then or when it is not one. `<iframe>`,
`<video>` and `<embed>` are boxes of their `width` and `height` — 300×150
without them, as HTML sizes them — with nothing in them, because nothing is
loaded.

**SVG:** an inline `<svg>`, an SVG image and an SVG background are drawn by
ntk's `SvgView`, which core's own `<svg>` element draws with, so they draw
its subset: shapes and paths, groups, `<use>`, gradients and plain text,
with presentation attributes and `style` attributes — not a stylesheet's
rules, filters, masks or clip paths. An SVG root's `width` and `height` are
CSS lengths, a percentage one too; its intrinsic size is what of them is
absolute, and its ratio comes from them or from its `viewBox`, which is
fitted to its box as `preserveAspectRatio` says. A percentage in its
geometry is of its viewport, and `currentColor` is the `color` the element
inherits. XHTML's `<svg:svg>`, under a prefix declared for the SVG
namespace, is the same element.

**Backgrounds:** `background-color`, and `background-image` — through
`onResource`, like an `<img>` — with `background-repeat` and
`background-position`, positioned in the padding box and repeated across the
border box, or against the viewport with `background-attachment: fixed`. An
image with no size of its own, an SVG's, is sized in that area as CSS
Images says. A `linear-gradient()` is drawn over the colour as an image the
size of the padding box, repeated like one: by angle, side or corner, with
its stops where they say or spread between their neighbours, and a colour
interpolation method, `in oklab` as Tailwind 4 writes it, read and not
honoured; the gradient is mixed in sRGB. Radial, conic and repeating
gradients are drawn as nothing, over the colour. The root's background
covers the whole canvas, as CSS 2.1 has it: `<html>`'s, or `<body>`'s where
`<html>` has none, over the body's margin and down the whole element when an
application grows it past the document — so an email's `<body bgcolor>`
colours the message rather than a box inside it. Its image is sized by the
root element and repeated over the rest, so a gradient on a page shorter
than the window repeats below it, in the stripes a browser shows.

**HTML's own attributes:** the presentational ones mail and generated
documents are written in are read as the styles they stand for, below
every author rule — `bgcolor`, `background`, `width` and `height`,
`cellpadding` and `cellspacing`, `border`, `valign`, a cell's `nowrap`, a
`<br>`'s `clear`, a rule's `color` and `size`, `<font>`'s, `<body>`'s `text`
and `link`, `dir`, and `align`. A table's `align` places the table
(`center` gives it auto margins, `left` and `right` float it); `<center>`,
and `align` on a div, a cell, a row or a row group, align the blocks in
them as well as their text, as browsers do with `text-align:
-webkit-center`, which is read too. A table with auto margins is centred
once it has shrunk to its columns, so a mail's button, a one-cell
`<table align="center">`, stands in the middle.

**Text:** `font` and its longhands, `line-height`, `text-align`,
`text-indent`, `text-transform`, `letter-spacing` and `word-spacing` (the
first is the text engine's; the second is spacing added to each space and
no-break space, so only text that asks for it is split into more runs),
`white-space` (including
`pre` and `pre-wrap`, on an element as well as on its block: a `nowrap`
element's words stay together, and `pre`'s spaces take their room at a
line's end, where other spaces hang; a line break straight after `<pre>`'s
start tag is dropped, as HTML's parser drops it), `direction`,
`unicode-bidi`, `vertical-align`,
`text-decoration` in all five rule styles. `unicode-bidi` is carried out as
the bidi controls it stands for, laid out around the element's text and no
part of the document's: a copy, a caret and a selection skip them. HTML's
`dir` isolates its element, `dir="auto"` and `<bdi>` take their first
strong letter's direction, and `<bdo>` overrides. `vertical-align` raises and lowers text as well as
images and inline blocks: the UA sheet's `<sup>` and `<sub>`, a length, a
percentage of the line height, `text-top`, `text-bottom`, `middle`, and
`top` and `bottom` against the line box, whose height each raised box adds
its own line height to. So does an inline box whose own `line-height` is
more than its paragraph gives its text: a span of 60px lines in a paragraph
of 20px ones makes a 60px line, with its text in the middle. A paragraph
holding either is laid out a line at a time. A box whose own line height is
less keeps the paragraph's multiple of its font's natural one, which in a
font with taller lines than the paragraph's — a `<code>` in Menlo beside
Helvetica — is a little more than CSS gives it. Underlines an element outside a raised text draws through it stay on
the line's baseline. White space collapses across element boundaries as CSS
2.1 16.6.1 has it — none at the start or the end of a line, one between two
words whatever elements they are in — and text at `font-size: 0` takes no
room, which is how a row of inline-blocks is set without gaps.

**Generated content:** `::before` and `::after`, and CSS 2's `:before` and
`:after`, as boxes of their own `display` holding what `content` comes to:
strings with their escapes, images, `attr()`, `counter()` and `counters()` in
every CSS 2.1 list style, and `open-quote`/`close-quote` over `quotes`. An
image is asked for through `onResource`, as a background image is, and is
an inline image in the pseudo-element's line, of its own size once it
arrives and of none before.
`counter-reset` and `counter-increment` are scoped as CSS 2.1 12.4.1 scopes
them, so numbered headings and nested outline numbers come out as they do in
a browser. The generated text is part of the document's text, so a selection
over it copies it.

**First letters:** `::first-letter` (and `:first-letter`) styles the first
letter of a block's first line, with the punctuation before and after it, as
an inline box of its own — or a float, for a drop cap. It is found down
through the block's inline content and its first child blocks, generated
content included, and there is none when something other than a letter
starts the line: a `<br>`, an image, an inline-block. The box sits inside
whatever the letter is in, so `<p><b>T</b>his` has a bold first letter. An
opening quote in a text of its own before the letter — `<q>`'s — takes the
letter's style too.

**First lines:** `::first-line` (and `:first-line`) gives the first
formatted line of a block its colour and background. A block whose first
line is a child's, as a `<div>`'s is its first paragraph's, hands the style
down to it. An element on the line with a colour of its own, a link, keeps
it. The line's font properties, spacing and `vertical-align` are not
applied: each would change where the line ends.

**Lengths:** `px`, `em`, `rem`, `ex`, `ch`, `vw`, `vh`, `vmin`, `vmax` and
the absolute units, and `calc()`, `min()`, `max()` and `clamp()` over them
(CSS Values 4). A math function comes down to pixels and a percentage, which
layout resolves as it does any percentage; `min(100%, 600px)`, a
comparison with a percentage in it, is resolved against each width it
meets. A percentage that cannot resolve makes the whole value `auto` where
a plain percentage would be, so `calc(40px + 10%)` against a height nothing
sets is no height. The constants `pi`, `e`, `infinity` and `NaN` are read,
and a calculation that comes to no finite number is what a browser makes
of it: NaN is nought, and an infinity the largest length there is.

**Logical properties:** `margin-inline`, `padding-block`, `inset-inline`,
`border-inline-start`, `inline-size`, `border-start-end-radius` and the
rest of CSS Logical Properties 1's, as the physical properties they are in
the horizontal writing mode `<Html>` lays out: the inline axis's start is
the left of a left-to-right element and the right of a right-to-left one.
Tailwind 4 writes its spacing in them — `px-4` is `padding-inline` and
`mx-auto` is `margin-inline: auto` — and its `inset-0` in the `inset`
shorthand, which is read too, as is a single corner's radius. A logical and
a physical declaration for the same side are one property: whichever comes
later in the cascade wins. The direction is the element's as the cascade
has it when the declaration is read — its parent's, or its own from `dir`
— so a `direction` declared later in cascade order than a logical property
on the same element does not move it.

**Custom properties:** `--name` declarations and `var()`, with fallbacks
(CSS Custom Properties 1), which is how Tailwind and most design systems
write their colours and spacing. A custom property is inherited, and a
`var()` is replaced before the declaration it is in is read, so it works
in shorthands and inside `calc()` and colour functions. One that names
nothing and has no fallback leaves its property `unset`, and a cycle has
no value. `:root` is the `<html>` element, the one a browser implies
around a fragment too, so a fragment's `:root { --brand: … }` reaches all
of it.

**Colours:** the named colours, hex with three, four, six or eight
digits, and CSS Color 4's functions: `rgb()` and `hsl()` in either the comma
or the space form, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, and
`color()` in its predefined spaces. They are read here and handed to the
drawing context as `#rrggbb` or `rgba()`, which both backends read alike,
and one outside sRGB is clipped into it. `color-mix()` mixes in any of
the spaces above but the wide-gamut RGB ones, premultiplied, so a colour
mixed with `transparent` keeps its hue: Tailwind 4's `bg-blue-500/50` is
written that way. A mix with `currentColor` in it is mixed where the
colour is used. Relative colours, `light-dark()` and the system colours
are not read, and a declaration using one is dropped, as a browser that
did not know them would drop it.

**Selectors:** everything [css-select] supports — combinators, attribute
operators, `:nth-child(an+b)`, `:not()` — plus `:hover`, which is answered
from this renderer's own pointer state. Escapes are read wherever they stand,
so a Tailwind class such as `md:flex`, written `.md\:flex`, matches. A group
with a selector in it that is not one — an unknown pseudo-class, a name that
starts with a digit — is dropped whole, as CSS 2.1 drops it. Rules nest
(CSS Nesting 1): a rule inside a rule's block is relative to it, `&`
standing for it and a selector without one a descendant, and an `@media`,
`@supports` or `@layer` inside one holds for the same element, which is how
Tailwind 4 writes its `hover:` and `md:` variants. `@media` width and
`prefers-color-scheme` queries are evaluated, widths in Media Queries 4's
ranges, `(width >= 48rem)`, as well as `min-width` — the scheme is the react-x11
palette's in force, so a `<ThemeProvider colorScheme>` above the element
answers it and a desktop that switches schemes re-cascades the document.
`@import` goes through the resource seam. Cascade layers are read (CSS
Cascade 5): `@layer a, b;` fixes their order, the document's across all of
its sheets, and a rule in a later layer wins over one in an earlier layer
whatever their specificity, a rule in no layer over both, and the other way
round for `!important`. Tailwind 4 writes all of its CSS in four of them.

**Not implemented:** the parts of CSS grid above, transforms,
animations and transitions, multi-column, shadows, gradients other than
linear ones,
`background-size`, more than one background
layer (the first is drawn), `position: sticky` (treated as `relative`),
and the font properties of `::first-line`. A `<col>`'s or a `<colgroup>`'s borders are
drawn only where the table's collapse. A percentage
`height` resolves where the containing block's height is set, and on an
absolutely positioned box. The initial containing block is the viewport —
the window's height, since the element sizes to its content — so
`html, body { height: 100% }` is a window tall and `bottom: 0` with nothing
positioned around it is the window's bottom, as in a browser; the document
is as tall as what overflows its root, so nothing longer than the window is
cut off. A fragment has no root element, and its blocks have the body's
`auto` height to resolve against.
Explicit bidi embeddings and overrides (U+202A–U+202E) that open on one side
of an inline element with padding, border or margin and close on the other
are resolved on each side of it separately: the text engine is handed the
text a piece at a time there.

## The decisions

**It draws the document; it does not compose one.** Every other document
surface in this package — `<Markdown>`, `<Code>`, `<TerminalOutput>` — is a
tree of `<box>` and `<richtext>` elements. This one is a single element that
lays out and paints the whole document, for two reasons. A document of any
size is thousands of elements, and reconciling them through React and laying
them out through yoga per streamed chunk is the cost this exists to avoid.
More importantly, **CSS layout is not the host's layout**: react-x11 lays out
with yoga, which is flexbox, and block flow with margin collapsing, floats,
an inline formatting context and table column sizing are not expressible in
it. Composing would mean approximating the layout model.

What it reuses from `<richtext>` is everything that was not about the
element: the `TextRun` vocabulary ntk's text layout takes, the per-run rule
painter for `text-decoration`, and the bidi-correct selection bands. See
[richtext](richtext.md) — including its caveat about react-x11's Windows
text engine, which hands runs back without their spans: there,
`text-decoration` draws nothing. An inline element's background and border
do not need the span, and neither does hit testing: a run finds the `<a>` or
`<span>` it belongs to from where its text sits in the document, on every
engine, so those are painted and `hrefAtPoint` answers there too.

**Form controls are real widgets, not pictures of them.** A `<select>` in a
document drops the same menu as a `<Select>` in the window around it, because
it _is_ one; the same goes for `<button>`, checkboxes, radios and text
fields. They mount as absolutely positioned siblings of the element, at the
rectangles layout reserved for them — the escape hatch [`<Flow>`](flow.md)
opened for a node whose body is a form. A drawn control would take no focus,
say nothing to a screen reader, and have to reimplement every keyboard
convention the platform already has.

**The application scrolls it, and height does not frighten it.** The element
sizes to its content; put it in a `<box overflow="scroll">`, the same shape
`<Markdown>` uses. That keeps the mounted controls scrolling with the
document for free, and core's scroller already blits. Tall is fine — a
multi-hundred-thousand-pixel document renders correctly at any scroll
position, because everything the paint path submits is bounded by the
viewport: fills are clamped to the damage (X carries them as 16-bit numbers,
so an unclamped one is a protocol error, not a clipped rectangle), long
hard-broken text is laid out in chunks so no single glyph batch spans more
than the Int16 envelope, and wide child lists and line arrays are searched,
not scanned. What phase 2 adds is cheaper _layout_ for such documents, not
the ability to show them.

**A fragment gets an implied body.** `<p>hi</p>` has no `<body>` element, so
the root box takes the style a `<body>` would have had: the user-agent
margin, the font, and any author `body { … }` rule, inheriting from an
implied `<html>` that author `html { … }` rules reach. Without it the same
markup renders differently inside and outside `<html><body>`, which reads as
a bug rather than as a missing element. A `<body>` with no `<html>` around
it, which is how a lot of mail starts, is still the body: its background
covers the whole canvas.

**The user-agent stylesheet is themed.** `color`, the link colour and every
rule and border in it come from the react-x11 palette, so an unstyled
document dropped into a dark application arrives dark rather than as a white
rectangle. An author stylesheet still overrides all of it.

**`:hover` costs nothing unless the document uses it.** A pointer move only
restyles when some selector in the document actually tests `:hover`, which is
why the user-agent sheet deliberately has no `a:hover` rule.

**Nesting is capped at 512, the way Blink's parser caps it.** Everything
after the box builder recurses on tree depth, so a degenerately nested
document (fuzzer output, a runaway template) would otherwise be a stack
overflow five phases from its cause. Content past the cap is dropped;
documents this deep are not documents.

## Streaming

`partial` works the way `<Markdown partial>` does, and rather better: the
parser is a real streaming one, so a `source` that extends the last one is
written as a **delta**. The nodes already parsed keep their object identity,
which means their computed styles, their boxes and their laid-out lines
survive; only the tail is new work. A `source` that is _not_ an extension
resets the parser, because a mid-document edit can change the tree
arbitrarily.

Set `partial={false}` when the stream ends.

**The delta is available only until then.** Ending the parse is final — an
ended parser cannot be extended — so once `partial` is false, every later
`source` re-parses, whether it extends the last one or not. That is the right
trade for a stream, which has nothing more to send. It is the wrong one for an
editor that hands over the whole document on every keystroke: leave `partial`
at its default there, so typing at the end stays an append and only a
mid-document edit costs a re-parse. The cost of leaving it true is that the
parser is never ended, so a document whose tail is an unfinished construct —
`<p>hi` mid-word — stays buffered until it closes.

## Manipulating the DOM

The document is [domhandler]'s tree — plain, mutable objects that
[domutils] operates on directly. This package re-exports the four splice
operations that are easy to get wrong (`appendChild`, `removeNode`,
`replaceNode`, and `createHtmlElement`/`createText`/`parseHtmlFragment` to
build nodes), because a domhandler node carries `parent`, `prev`, `next` and
`children` and a splice has to keep all four straight.

After mutating, call `handle.refresh()`. That is explicit on purpose:
observing a plain object graph would cost a proxy per node and tax the static
render this is built to make fast, in order to speed up the path it is not.
Mutation is supported; it is not where the performance budget went.

## Performance

The pipeline is staged so that the two things that happen most often cost the
least:

| What changed       | What re-runs                                     |
| ------------------ | ------------------------------------------------ |
| `source`           | parse (incrementally), style, box, layout, paint |
| a stylesheet       | style, box, layout, paint                        |
| the DOM            | box, layout, paint                               |
| the width          | layout, paint                                    |
| a `@media` band    | style, box, layout, paint                        |
| an expose / scroll | paint, culled to the damage rect                 |

Nothing in a computed style depends on the width — percentages and `auto`
survive unresolved into layout — which is what makes a resize skip the
cascade. Every box carries the ink bounds of everything it and its
descendants draw, and past a size threshold a child list carries a sorted
viewport index, so an expose of a 40-pixel strip in a very tall document
finds the boxes that overlap it by binary search rather than by scanning
the document. The selection walks prune the same way — by each subtree's
document range, and by ink-bounds distance for hit testing — so a drag costs
the paragraphs it crosses. And a paragraph is one glyph batch: ntk's text
layout draws all of its lines in a single composite.

**Text layouts are kept from one pass to the next.** An edit re-parses the
document and lays it out again — any character of an HTML string can change
any box — and most of a layout pass was the text engine setting paragraphs
it had set the pass before. So each is kept under what went into it (the
runs' text and styles, the width, the alignment), and a pass asks the engine
only for what changed: an edit or an append to a 600 KB document went from
355 to 128 ms on macOS and from 202 to 93 ms on XQuartz. A run carries no
element for this to work — a layout made for one parse is shown for the
next — which is why hit testing goes through the document's text index
rather than through the run. The pass before's layouts are all that is
kept, so a document costs one pass of them and the ones an edit replaced.
A layout is filed under a number hashed from its width and the ends of its
text, and found by comparing what it was made from, the fields named one
by one: each run's, which `TextRun` has, the block's style, which is a
run's without the text, and the options. Spelling all of it into one
string key meant 3 MB of strings a pass at 600 KB, built, hashed and
compared, and a tenth of an edit went on finding the layouts; a summary
spelled as a string, and walking each object's own fields, were still a
fifth of a pass's layout. The natural line height a `line-height: 1.5` is
converted against is kept per style for the same reason, found by the
style object before its face: every paragraph asks, and on CoreText every
answer was a call to the native side.

**A resize lays the document out once a frame.** Core asks an element for
its height at the width it was last measured at, as well as at the one it
has now, to find out whether a relayout changed what the element needs.
The boxes hold one width, and the document answered the other by laying
itself out there, then at the new width again for the pass after: three
passes over all of its text a frame. The size a width came to is kept
instead, a few widths deep, and answers until anything a layout reads
changes: the source, a stylesheet, a resource, the hover, the viewport
height. Only a size comes from it; paint and the selection read the boxes,
and those are only ever laid out for real. A frame of a window resize at
600 KB went from 573 to 196 ms on macOS and from 256 to 86 ms on XQuartz.

**A style is computed once per kind of element.** An edit builds the box
tree again, and building it matched every element against the stylesheets
and computed its style: 9,039 of them for a 600 KB report. A document is a
few kinds of element many times over, though, and a style depends only on
the parent's, the element's own tag and attributes, and its ancestors' —
unless a rule reads siblings, position or contents: `+`, `~`,
`:nth-child()`, `:first-child`, `:empty`, `:has()` and css-select's other
names for them. So an element that looks, from the root down, like one
already styled in the same build takes that style object without matching
anything. An element such a rule could reach is matched, and then shares by
what it matched, so the cells of a striped table come in two kinds rather
than needing a style each. The report computes 110 styles, and 112 with its tables striped.
An edit went from 111 to 76 ms on macOS and from 80 to 54 ms on XQuartz, an
append from 118 to 83 ms and from 88 to 59 ms.

**A padded inline box leaves its paragraph one layout.** Its padding,
border and margin take room on its line, and one layout of the
paragraph's text has none to give them; set a line at a time instead, the
paragraph cost a layout per line and per box, five for a paragraph with
one inline `<code>` in it. Where nothing on its lines has to be placed a
piece at a time, with no image or inline-block, no float beside it, no
`text-indent` and nothing right to left, each edge goes into the one
layout as a no-break space letter-spaced to the edge's width. It goes to
the line its box's text goes to, and a caret, a point and a selection step
over it, so a selection of a code span's text leaves its padding out. A
frame of a resize at 600 KB went from 172 to 92 ms on macOS and from 124
to 59 ms on XQuartz, and the first paint from 581 to 521 ms and from 549
to 464 ms.

## Types

`Document`, `Element`, `AnyNode`, `ChildNode` and `ParentNode` are
domhandler's, re-exported. Through the barrel they are qualified —
`HtmlDocument`, `HtmlElement` — because an application already has several
things called `Element`.

## Example

```bash
npm run examples:html
```

Needs a real `$DISPLAY`. It renders a document with headings, floats, tables,
a flex row and a working form, and drives both seams for real: a resource
loader that reads from a whitelist directory, and a script hook that reports
what it was handed without running it. Its stylesheet is light on its own and
re-tints under `@media (prefers-color-scheme: dark)`, so the same document
follows a dark desktop.

[domhandler]: https://github.com/fb55/domhandler
[domutils]: https://github.com/fb55/domutils
[css-select]: https://github.com/fb55/css-select
