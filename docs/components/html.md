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
| `baseUrl`         | `string \| null`                                 | The URL the document came from. With it, every URL reaches `onResource` and `onLink` absolute — see [Base URLs](#base-urls). Absent, URLs are handed over as written.        |
| `onResource`      | `(r: ResourceRequest) => ResourceResult \| null` | An `<img>`, a `<link rel=stylesheet>`, an `@import` or an `@font-face` font wants loading. May return a promise. **Absent, nothing loads.**                                  |
| `onScript`        | `(s: ScriptRequest) => void`                     | A `<script>` was found, handed over unparsed and unevaluated.                                                                                                                |
| `onLink`          | `(href, ev) => void`                             | A link was activated. Absent, clicks do nothing — this never navigates by itself.                                                                                            |
| `onDocument`      | `(document: Document) => void`                   | The parsed DOM, each time it is re-parsed.                                                                                                                                   |
| `onControlChange` | `(element, value) => void`                       | A form control changed, or a `<button>` was pressed, with its `value`. The element is the one in the DOM.                                                                    |
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

| Member                 | What it is                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document`             | The live DOM — [domhandler]'s tree, which [domutils] speaks natively.                                                                                                                                                                                                                                                                                                                                                      |
| `refresh()`            | The DOM changed: restyle, re-lay-out, repaint.                                                                                                                                                                                                                                                                                                                                                                             |
| `elementAt(x, y)`      | The element under a point, in the window's logical coordinates — the ones a mouse event's `x`/`y` carry.                                                                                                                                                                                                                                                                                                                   |
| `hrefAt(x, y)`         | The link under a point, resolved as `onLink` is handed one — for a status bar, or a menu on a link.                                                                                                                                                                                                                                                                                                                        |
| `elementRect(element)` | Where an element is, in logical pixels from the document's top left — the space a scrolling box's offset is in. A block's border box; an inline element's across its fragments, padding and border included, as `getBoundingClientRect` measures it, and as tall as its lines — and, where a block inside it broke it in pieces, across the lines of those blocks too, as a browser's is. Null for an element with no box. |
| `title`                | The document's `<title>`, if it had one.                                                                                                                                                                                                                                                                                                                                                                                   |
| `base`                 | What the document's relative URLs resolve against — its `<base href>`, or `baseUrl` — or null.                                                                                                                                                                                                                                                                                                                             |

`refresh()` is explicit rather than observed, and that is a decision — see
[Manipulating the DOM](#manipulating-the-dom).

## The seams

**`onResource` is the only way anything loads.** This component has no
network client and no filesystem access. The request names the URL, what
kind of thing it is, and the element that asked:

```jsx
onResource={async (request) => {
  if (!allowed(request.url)) return null;
  if (request.kind === 'stylesheet') {
    return { kind: 'stylesheet', text: await readText(request.url) };
  }
  if (request.kind === 'font') {
    return { kind: 'font', bytes: await readBytes(request.url) };
  }
  return { kind: 'image', bytes: await readBytes(request.url) };
}}
```

Image bytes may be PNG, JPEG, GIF — its first frame — or SVG; nothing names
the type, so each is told apart by its bytes. Return
`{ kind: 'image', image, width, height }` instead to hand over an image the
host decoded itself. A declined or absent resource is an ordinary state:
images draw as a frame at their attribute size, an `<object>` shows its
fallback content, linked stylesheets are skipped and text is set in the
fonts the system has. A resource may arrive whenever it arrives: a
stylesheet that comes after the first paint restyles the document, and an
image rebuilds its boxes.

`@import` is asked for through the same seam, an import inside an import
too, each sheet's rules standing where its `@import` does; a sheet that
imports itself, or one of the sheets importing it, is read once.

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

### Base URLs

The component has no idea where a document came from — it is handed a
string — so by default the URL in a request is the one the document wrote,
and resolving it is the host's. Give it `baseUrl` and it resolves them
itself, as a browser does, and hands every URL over absolute:

- a URL in the markup — `<img src>`, `<link href>`, a `style` attribute's
  `url()` — against the document's first `<base href>`, itself resolved
  against `baseUrl`, or against `baseUrl` where it has none;
- a `url()`, an `@import` or an `@font-face` source in a **linked or
  imported stylesheet** against _that stylesheet's_ URL, as CSS says, which
  is the one thing the host could not have done: by the time a background
  is asked for, nothing says which sheet it was written in. A stylesheet
  result may carry `url`, where the host was redirected — `{ kind:
'stylesheet', text, url }` — and the sheet's URLs resolve against where
  it came from in the end;
- the `href` handed to `onLink`, and the one `handle.hrefAt` answers.

An absolute `<base href>` in the document is a base without the prop. With
neither, nothing is resolved, and a host rendering mail or a help page sees
exactly what it saw before. Nothing is fetched because of a base: it says
where a URL points, and `onResource` still decides whether anything goes
there.

### Fonts

An `@font-face` is read, and its family is the document's to use:

```css
@font-face {
  font-family: Inter;
  src:
    url(inter.woff2) format('woff2'),
    url(inter.woff) format('woff');
  font-weight: 100 900;
  unicode-range: U+0000-00FF;
}
```

A source is asked for as `{ kind: 'font', url }`, and handed back as the
file's bytes, `{ kind: 'font', bytes }` — TrueType, OpenType, WOFF or WOFF2.
What decides whether one is asked for at all is the page, as it is in a
browser: a face loads when a computed style wants its family at its weight
and slant, the nearest face to them as CSS Fonts 4 matches one, and when a
character of the document falls in its `unicode-range`. A Google Fonts sheet
declares a family once per script and a self-hosted family often declares
every weight it has; a page that uses two weights of the Latin half asks for
two files. The sources are tried in order: one whose `format()` is not a
font a text engine reads (`embedded-opentype`, `svg`) is passed over, and so
is one the host declines or whose bytes do not register — a WOFF2 on macOS,
whose CoreText reads no such container, falls through to the WOFF beside
it. `local()` is not looked up.

Until a face has loaded its family is left out of the list, and the text is
set in the next family the author named, as `font-display: swap` has it;
when it arrives the document is set again.

**A family is registered under a name nothing else has.** Fonts go to
react-x11's font manager, which is the application's, so the component
registers each family's faces under a private name (`loadFont`'s `family`)
and rewrites the document's `font-family` lists to it. A page's `Inter`
changes nothing that `Inter` means to the window around it, to another
document, or to a page that ships another file under that name — an icon
font called `Icons` on two sites is two sets of glyphs. Two documents that
declare a family the same way, the same files at the same weights, share one
registration, so the second is not asked for it at all. What is still the
application's is the font manager's fallback chain: a registered face can
supply a glyph that no other face has to text anywhere in the app, and
nothing is ever unregistered, which react-x11's `loadFont` documents.

## What renders

The subset is aimed at documents an application is handed — mail, release
notes, help pages, exported reports, generated summaries — rather than at the
open web. How much of CSS 2.1 that comes to, measured against the W3C's own
test suite on both backends, is in
[`<Html>` against the CSS 2.1 test suite](../html-conformance.md).

**Layout:** block flow with margin collapsing, inline formatting with
bidi and full shaping — a word that runs across elements shaped as one,
kerned and joined across them, but for an element with a margin, border or
padding at a side, whose text is shaped on its own — `inline-block`, floats
and `clear`, lists with their
markers, tables (the auto algorithm and `table-layout: fixed`, with `colspan`
and `rowspan`, and the anonymous table CSS builds around table parts that
have none), `position: relative | absolute | fixed | sticky`, `display: flex` (and
the legacy `-webkit-box`, a flex box in its `-webkit-box-orient`'s
direction, packed, aligned and flexed by the `-webkit-box-*` properties as
Blink lays one out, or where it clamps its lines vertically a block of its
own formatting context), and
`display: grid` as documents write it (below), and `display: contents`,
which makes no box and hands its children, its `::before` and its
`::after` to its parent's, in its style — a replaced element set so is not
rendered. An
inline-block sits on its last line's baseline and an inline-table on its
first row's, each on its bottom margin edge where it clips what overflows
it; an inline flex box sits on its first item's, clipping or not, and a
block that clips has its first line's baseline all the same — only its
last is its margin edge (CSS Box Alignment 3, 9.2). A sticky box is placed
at rest: moved only as far as keeps it inside its scroll container's
scrollport, scrolled to its start, less its insets, and its margin box
inside its containing block. Nothing here scrolls a box the document
holds, so that is where one inside such a box stays; the viewport does
scroll, and against it only `top` and the start side are kept — a sticky
box is where a browser starts it, and scrolls away with the page rather
than following it, where a `bottom: 0` footer would otherwise be pinned to
the middle of it. A float, an inline-block and an absolute box of `width: auto`
shrink to fit the room their margins leave, and an absolute box the room
its offset or its static position leaves: at `left: 50%` it has half the
width. None is narrower than its longest word. A relatively positioned inline box moves its text, its
background and borders and any block inside it, and leaves its lines where
they were, which is how Tailwind's preflight and normalize.css raise a
`<sup>`; a paragraph with one is laid out a line at a time, as one with an
inline-block is. A list's marker hangs outside its item, or with
`list-style-position: inside` is the first thing on its first line and
takes its room there; a `list-style-image` is the marker where it loads —
asked for through `onResource`, its bottom on the first line's baseline —
and the `list-style-type`'s is until then. An outside marker that reaches
higher above its baseline than the item's first line does makes room as
Blink does: the line grows where it is the item's own, and where it is in a
block inside the item — a paragraph, a link set `display: block` — the
block goes lower by the difference and keeps its height. A `::marker` rule sets its colour and its font, and a
`content` sets it as that, counters and all. A list item counts with the
`list-item` counter, which `<ol>`, `<ul>` and `<menu>` reset, and which
`start`, `value`, `reversed` and `type` set as HTML has them: an
`<ol reversed>` counts down to 1. A `list-style-type` is any counter style
of CSS Counter Styles 3 — the numeric ones of twenty-odd scripts, the kana,
the Chinese, Japanese and Korean longhands, `ethiopic-numeric` — one an
`@counter-style` rule defines, over them or extending them, or
`symbols()`; the marker is the style's prefix, number and suffix, set off
by the suffix's space in its own face, or against the text where the
suffix has none, as `、` does, and its direction is its own. A string
`list-style-type` is the marker as it is written, and an outside marker of
a right-to-left item stands at its right, reading right to left. A `<details>` shows its first `<summary>` and nothing
more until it is `open`, the summary with the ▸ or ▾ HTML gives it — a
system font's, where the document's has none.
A flex container is laid out by Yoga, the engine react-x11 lays itself out
with, and each item by this one: an item of `width: auto` is as wide as its
content, its max-content width, before the row grows or shrinks it, its
padding and border counted once, and a width, height or basis of its own is
its content box's unless `box-sizing` says otherwise. An `auto` margin takes
the free space on its side, so `margin-left: auto` puts an item at the end
of its row. A row of flex items inside another item is as wide as its items
side by side and the gaps between them; a gap is a length, or a percentage
of the container's size along it. The items are laid out in the
container's content box, its height less the padding and borders a
`border-box` height holds, and a container with no height of its own gives
its `flex: 1` items what its `min-height` leaves them, so a page
`min-h-screen flex flex-col` puts its footer at the bottom of the window. An item is shrunk no smaller than its
content comes to — its min-content width in a row, its content's height in a
column — unless its own minimum or an `overflow` that scrolls lets it go,
as Tailwind's `min-w-0` does; in a column that is the lesser of a height of
its own and its content's, and an item with an `aspect-ratio` counts its
width through the ratio as content, and along a row a definite height
through it. An item with a ratio is as wide, down a column, as the height
it was flexed to makes it, and an image grown along a row is as tall. A
`flex-basis` holds down a column with no height of its own, where Yoga
would read the item's height in its place. An item stretched across its
row, or flexed along a column of a height of its own, has the height it was
given — no taller for what it holds — for what it holds to take a
percentage of, so an `h-full` list in a sidebar fills the sidebar. Items go in `order`, and in the document's where two have the
same, and are painted so; one with a `z-index` is a stacking context
whether or not it is positioned, a grid's item too. Items aligned by their `baseline` line up their first lines, their
line as tall as that makes it, and a flex box sits on the baseline of its
first line's item aligned so, or of its first item. Items meet where
they meet, fractions of a pixel included, and the paint snaps their edges.
A grid (CSS Grid 1) takes its tracks from `grid-template-columns` and
`grid-template-rows`, or the `grid-template` and `grid` shorthands —
lengths, percentages, `fr`s, `auto`, `minmax()`, `fit-content()`, and
`repeat()` by a count or by what fits, an `auto-fit` repetition that no item
is in collapsing with the gaps beside it — and those past the template from
`grid-auto-columns` and `grid-auto-rows`, with gaps of lengths or
percentages of the grid's size along them.
It places its items by line, span, line name or the area
`grid-template-areas` names, or in order into the first cells free, along
the rows or down the columns by `grid-auto-flow`, `dense` or not, and
sizes its columns and its rows by the track sizing algorithm:
an item spanning several tracks grows the ones its content sizes, and the
`fr` rows of a grid with a height or a `min-height` fill it, which puts a
page's footer at the bottom. `justify-content` and `align-content` place
the tracks. An item is stretched to its area or aligned in it by
`justify-self`, `align-self` and its `auto` margins, and one that is not
stretched is as wide as its content fits. `normal` stretches an item but an
image, which keeps its own size, and a box with an `aspect-ratio`, which is
as wide as a height it has makes it, and as a block would be where it has
none; an item stretched down its area is as wide as its ratio makes that
height. An item's percentage height is of its area, and a stretched item's
height is one what is in it takes percentages of. A grid is as wide as
its tracks, whatever runs past them. An absolutely positioned box
takes the grid area its lines name for its containing block, and a grid's
or a flex box's child is where it would be as the box's one item.
Baseline alignment and subgrids are not read.
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
at the right. `empty-cells: hide` draws neither background nor borders for
a cell with nothing in it, where borders are separate. A table taller than
its rows gives them the rest as browsers do, which CSS 2.1 leaves open:
first to the rows a percentage sets, up to it, then to the rows with
content that nothing sets, and, where every row with content is set, to
the empty ones.
A block in an inline element breaks it (CSS 2.1 9.2.1.1): the pieces of the
element before and after the block are on lines of their own, without an
edge where the block cut them, and the block stands between them as a
block, so `<font>` around paragraphs, or a link around a card, keeps its
blocks stacked.
A block that makes a formatting context of its own — an `overflow` that
scrolls (any but `visible` and `clip`), a table, `display: flow-root` —
holds its floats and sits beside
another block's rather than under them, its margins its containing
block's: a column with `overflow: hidden` and a 220px margin beside a
200px sidebar starts 220px in, the margin overlapping the float, and one
the floats leave too little room for goes below them. One too wide for its
containing block where no float narrows its room stays where it is and
overflows it, as it would with no floats; below them it would be as wide.
A float in a paragraph goes on the line it is met on (CSS 2.1 9.5.1): at
that line's top where it fits beside what the line holds already, which
moves over for it, and at the next line's top where it does not — so an
image floated from the middle of a paragraph starts at its own line, and
the lines above it keep the paragraph's width. Where the line cannot break
at the float, as in `nowrap` text, what follows it up to where the line can
has to fit beside it too. A word with too little room
left on a line after an inline-block or a float goes to the next line
whole.
A line with an inline-block or a padded element on it is laid out a piece
at a time and put in visual order by the paragraph's own UAX #9 levels,
resolved once over its text with an object replacement character for each
image, as CSS Writing Modes has one taken. A piece the engine would order
as the paragraph does is kept whole; one whose letters another piece's go
between, or that an embedding or override opened outside it reorders, is
laid out again a run of one level at a time. So an override that opens on
one side of a padded element and closes on the other reads across it, the
space beside an image in a right-to-left paragraph goes where the letters
around it say, and the line is aligned whole: a centred line is centred
with its images, not text first and the image after it. An element that
reordering splits apart on a line is drawn as a box around each of its
parts, as CSS 2.1 9.10 has it.

**Boxes:** `width`/`height` with `min-`/`max-`, `margin` (a negative one
on an inline box takes its room back from the line), `padding`,
`border` (width, style, colour, radius; a width is whole device pixels,
rounded down, and a hairline one), `box-sizing`, `overflow`, `clip`,
`opacity` — an element under 1 is a stacking context painted whole in its
place, the positioned boxes in it with it, at 0 not at all and between
faded, each thing drawn in it multiplied rather than the
group, so where two of its boxes overlap the lower shows through; a block
inside an inline element is faded with it, and the inline element's own
text is not — `visibility` — a
hidden element keeps its room and draws nothing, its text included, and a
visible element inside it is drawn; a
collapsed table row or column gives its room and its spacing back —
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
box with sides of different colours has them drawn straight. `groove`,
`ridge`, `inset` and `outset` are drawn in two shades of their colour, lit
from the top left and shaded as Chromium shades them — a groove in black
is black against a dark grey — each side a trapezoid meeting its
neighbours on the diagonal, which is what the UA sheet's `<iframe>`
border, `2px inset`, is drawn with. An image is
trimmed to the corners too — an `<img>` to the curve of its content edge,
so an avatar is a round photograph, and a background to its box's — at the
cost on X11 of a clip the size of the window, which only a rounded box
pays. A box whose `overflow` is not `visible`
clips what it holds to its padding box, rounded where the box is — all of
it but a positioned box whose containing block is outside — and `scroll`
and `auto` clip the same, with no scroll bars: the element around the
document is what scrolls. `clip` clips as `hidden` does and makes no
scroll container, so it makes no formatting context and leaves a flex or
grid item its automatic minimum; beside a value that scrolls, a `visible`
axis is `auto` and a `clip` one `hidden`. `clip` on one axis cuts only that
one. `overflow-clip-margin` moves the edge `clip` and paint containment
cut at: out from the box it names by its length, or in where the length is
negative, the rounded corners moving out as a browser's do. A box that
scrolls cuts at its padding box whatever the margin says. A table clips to its table box, with its
captions outside the clip. `clip` shows the part of an absolutely positioned
box it names. Inline elements have all of it but the
sizes: an inline box's padding, border and margin take room on its line —
the start side before its first fragment, the end side after its last, on
the sides its `direction` says (CSS 2.1 8.6) — and its background, images
and gradients included, and its border are painted a fragment a line, over
its face's height plus its vertical padding, which is why they do not make
the line taller. Where it wraps it is
sliced (`box-decoration-break: slice`, CSS's default): no border and no
rounded corner on a side it goes on from, and its images and gradients
placed as though its fragments were one box laid end to end in its
`direction`, each showing its slice — so an icon `no-repeat` at its start is
on its first line alone, and a gradient runs once across every line.
`box-decoration-break: clone` places them in each fragment's own box
instead; its fragments still take their borders and padding at the box's
two ends alone, where a browser gives every fragment its own. A padded
`<a>` set as an email's button, a pill badge and a `<kbd>` keycap render as
a browser renders them. Its edges are no place for a line to break (CSS
Text 3, 5.1): a line breaks at one only where it breaks the same text
without it — after a space, after a hyphen, between two ideographs — so a
word that runs on into an element, or that an element closes after, goes
to the next line whole with the edges it holds on to, and a line too
narrow for it runs past its end.

As in a browser, `display: none` is all that hides `<head>`, `<title>`,
`<style>` and `<script>`: a stylesheet that shows them shows them. What the
markup leaves outside a `<head>`, at the top of the document, is in the
head a browser implies, and stays hidden.

**Replaced content:** an image is sized by its style and what it has of
an intrinsic width, height and ratio (CSS 2.1 10.3.2, 10.6.2), and a
`min-`/`max-` limit on one axis carries to the other through its ratio — an
`<img width="600" style="max-width: 100%">` in a narrow column is scaled,
not squashed (10.4). `object-fit` fits the image to its box — stretched,
the default, or at its own ratio, within it, over the whole of it
(`object-cover`, an avatar's), at its own size, or the smaller of those,
an SVG with only a `viewBox` sized from its ratio — and `object-position`
places it on the pixel grid, in the middle unless it says otherwise, and
by its lengths even when it is stretched; what falls past the box is cut.
An `<object>` whose `data` is an image shows it, and its fallback content
until then or when it is not one; an `<embed>` whose `src` is an image
shows it, and a `<video>` its `poster`, contained in its box as HTML's
style sheet has it. `<iframe>`, and a `<video>` or an `<embed>` with no
image, are boxes of their `width` and `height` — 300×150 without them, as
HTML sizes them — with nothing in them, because nothing is loaded or
played.

**Intrinsic sizes:** `width`, `min-width` and `max-width` take
`fit-content`, `max-content` and `min-content` — Tailwind's `w-fit`, `w-max`
and `min-w-max` — as CSS Sizing 3 has them: a block as wide as its content
where its room holds it, auto margins centring it; one as wide as its
longest line, or as its longest word, whatever the room; a flex item of one
not stretched across a column, and a row item not shrunk below it. And
`fit-content()` of a length or a percentage, which fits the content in the
room its argument makes: no wider than the content at its widest, nor
narrower than its longest word. The sizes are the content's, whatever
`width` the box has beside them. A height of one is its content's, which
is `auto`. `stretch` — and `-webkit-fill-available` and `-moz-available`,
as pages still write it — is what the box's margins leave of its
containing block, in `width`, `height` and their limits: a float, an
inline-block or an absolute box fills its room as a block does, an
absolute one from its static position where it has no offsets, and a
block with a formatting context of its own, or an image, the room the
floats beside it leave. Down a block, a margin that meets no border or
padding of its parent counts for nothing, as it would collapse through the
parent's edge; where the containing block's height is not known,
`stretch` is `auto`, and as a least height nothing.

**Transforms:** `translate`, and the translation in a `transform` —
`translate(-50%, -50%)`, Tailwind's `-translate-x-1/2` in either of the
ways it is written — move a box after layout, as `position: relative`
does, a percentage being of the box's own size, so the absolute box it
centres is centred. A transformed box is a containing block for the
absolute and fixed boxes inside it and is painted with the positioned
boxes, as in a browser. Rotating, scaling and skewing are read and not
drawn, and a transform on an inline box that is not an atomic one moves
nothing, as CSS has it.

**Containment:** `contain` — `size`, `inline-size`, `layout`, `paint`,
`style`, and `strict` and `content` for them — and `contain-intrinsic-size`
(CSS Containment 2). A box with size containment is laid out as though it
held nothing, as large as `contain-intrinsic-size` says or no larger than
its padding and border, and an image as though it had no size or ratio of
its own; `inline-size` does that across alone. Layout and paint
containment make the box a formatting context, a stacking context and the
containing block of every absolute and fixed box in it, and layout
containment keeps its baseline in; paint containment clips what the box
holds to its padding box, as `overflow: clip` does. Style containment keeps
what the box's subtree does to counters and quotes in it: a counter made
outside it is not counted on inside, and the quotes are as deep after it as
before it. Any containment on `<html>` or `<body>` keeps the body's
background and `overflow` its own rather than the canvas's and the
viewport's. `content-visibility: auto` is layout, paint and style
containment, and `hidden` all four and the box's content left unpainted.
An image's `width` and `height` attributes give it the ratio they make as
well, as HTML maps them.

**Ratios:** `aspect-ratio` makes an `auto` height of the width, of the box
`box-sizing` names — Tailwind's `aspect-video` and `aspect-square` — and
that height is one a percentage inside resolves against. A box grows past
it to hold its content, as CSS Sizing 4 has it, unless it clips or has a
`min-height` of its own; a replaced element takes it over its own ratio,
or, written `auto 16 / 9`, only where it has none. The ratio runs the other
way too: a box with a height and an `auto` width, or one of its content's,
is as wide as the height makes it, and a least or greatest height is a
least or greatest width through it.

**SVG:** an inline `<svg>`, an SVG image and an SVG background are drawn by
ntk's `SvgView`, which core's own `<svg>` element draws with, so they draw
its subset: shapes and paths, groups, `<use>`, gradients and plain text,
with presentation attributes and `style` attributes — not a stylesheet's
rules, filters, masks or clip paths. An SVG root's `width` and `height` are
CSS lengths, a percentage one too; its intrinsic size is what of them is
absolute, and its ratio comes from them or from its `viewBox`, which is
fitted to its box as `preserveAspectRatio` says. A percentage in its
geometry is of its viewport, and `currentColor` is the `color` the element
inherits. An SVG image's root `background-color`, in its `style`, covers
the whole image, as a browser paints it over the canvas. XHTML's
`<svg:svg>`, under a prefix declared for the SVG namespace, is the same
element.

**Backgrounds:** `background-color`, and `background-image` — through
`onResource`, like an `<img>` — with `background-repeat`, `space` and
`round` among it and each axis its own, and `background-position`, placed
in the box `background-origin` names — the
padding box unless it says otherwise — and painted, and repeated, across
the box `background-clip` names, the border box unless it says otherwise,
with that box's rounded corners; or placed against the viewport with
`background-attachment: fixed`. An
image with no size of its own, an SVG's, is sized in that area as CSS Images
says, and `background-size` sizes any image: `cover`, `contain`, or a width
and a height, either `auto` and taken from the image's ratio. A background
has any number of layers, each with its own image, repeat, size, position,
attachment, origin and clip, painted bottom first over the colour, which
is clipped with the bottom layer. `background-clip:
text` paints the background through the element's text instead of behind its
box — Tailwind's `bg-clip-text text-transparent` headline, with
`-webkit-text-fill-color` read as the glyphs' own fill — as the text laid
out again with no ink of its own and filled with the gradient, which both
text engines do natively. `background-clip: border-area` (CSS Backgrounds 4)
paints a layer where the border paints: its widths and styles and not its
colour, so a transparent border shows the layer through a double border's
two lines, a dotted one's dots or a rounded one's ring, the shapes the
border itself is drawn with. With `text` it paints in both. A `linear-gradient()` is drawn over the colour as
an image the size of the padding box, or the size `background-size` gives
it, repeated like one: by angle, side or corner, with its stops where they
say or spread between their neighbours, and a colour interpolation method,
`in oklab` as Tailwind 4 writes it, read and not honoured; the gradient is
mixed in sRGB. Radial, conic and repeating gradients are drawn as nothing,
over the colour. The root's background covers the whole canvas, as CSS 2.1
has it: `<html>`'s, or `<body>`'s where `<html>` has none, over the body's
margin and down the whole element when an application grows it past the
document — so an email's `<body bgcolor>` colours the message rather than a
box inside it. Its image is sized by the root element and repeated over the
rest, so a gradient on a page shorter than the window repeats below it, in
the stripes a browser shows.

**Shadows:** `box-shadow`, outer and inset, with offsets, blur, spread and
any number of them, under the box's background and over it: a card's,
Tailwind's `shadow-*`, and its `ring-*`, which is a shadow that only
spreads and draws a border without taking room. A spread rounds a corner
out by less than itself where the radius is small beside it and the box
is not already round, as browsers do, so a ring keeps a card's corners
nearly square and a circle's round. An outer shadow is not
drawn under its box, which a box's own opaque colour usually sees to and
a cut sees to where it does not. A blurred shadow is the 2d context's
own, cast by the box's rounded rect — an inset one by a rect less that
shape, filled evenodd — and react-x11's contexts draw those from a tile
they make once for the corners, the blur and the colour, and stretch along
the straight edges, on X11, macOS and Windows alike. So thirty cards with
one shadow blur it once, and a strip a scroll exposes across a shadow a
hundred pixels wide draws a strip of it, where a surface kept for the part
of the shadow a paint reached was made again for every strip, which at 2x
was most of each frame on a page with one in view.

**Border images:** `border-image` and its longhands, over an image, an
SVG drawing or a `linear-gradient()`: the image cut into nine by its
slices and drawn over the border, and past it by the outset, in place of
the border's style — the corners scaled into theirs, the edges along their
sides stretched, repeated from the middle, rounded to whole tiles or
spaced, and the middle for `fill`. Where the image is not there yet, the
border is drawn as its style says. A piece is scaled from a copy of its
own, so no colour of the image next to it bleeds into its edge.

**Masks:** `mask-image` and the longhands that place it — `mask-repeat`,
`mask-position`, `mask-size`, `mask-origin`, `mask-clip` — and the `mask`
shorthand, each under its `-webkit-` name too (CSS Masking 1). The element
and everything in it are drawn as a group on a surface of their own and cut
by the alpha of its mask layers, which are placed, sized and repeated as a
background's layers are, in its border box unless they say otherwise, and
added one over another; the group is then drawn in its place, cut to the
mask painting area. That is how Wikipedia and every design system that
draws its icons with CSS writes an icon: a `background-color` masked by an
SVG. A layer whose image has not arrived is transparent, so an icon is not
drawn at all until its image is, rather than as a solid square. A mask is
an image's alpha: `mask-mode: luminance`, and the compositing operators
but `add`, are read and not honoured, and a `url(#id)` naming an SVG
`<mask>` element in the document draws the element unmasked. Where the
backend has no offscreen surface, the element is drawn unmasked. A
`@supports` test of a mask property answers that it is supported, so the
background image a page keeps under `not` for an engine without masks is
not drawn under the mask; every other `@supports` block is entered, as it
always was.

**Outlines:** `outline` and its longhands, and `outline-offset`: a border
of the outline's width, style and colour round the border box grown by
the offset, taking no room and drawn over the box's content, with the
box's rounded corners grown along with it — a focus ring, an avatar's
ring, and Tailwind UI's `-outline-offset-1` hairline over an image's
edge. An inline box's is drawn round each of its fragments; `auto` is
drawn solid and `invert` in the text's colour.

**HTML's own attributes:** the presentational ones mail and generated
documents are written in are read as the styles they stand for, below
every author rule — `bgcolor`, `background`, `width` and `height`,
`cellpadding` and `cellspacing`, `border`, `valign`, a cell's `nowrap`, a
`<br>`'s `clear`, a rule's `color` and `size`, `<font>`'s, `<body>`'s `text`
and `link`, `dir`, and `align`. A table's `align` places the table
(`center` gives it auto margins, `left` and `right` float it); `<center>`,
and `align` on a div, a cell, a row or a row group, align the blocks in
them as well as their text, as browsers do with `text-align:
-webkit-center`, which is read too — and a table they hold is centred,
its cells' text left at their start, as a browser resets that alignment on
a table: the body table of a mail stands in the middle of its
`<td align="center">` with its text where the mail wrote it. A table with
auto margins is centred once it has shrunk to its columns, so a mail's
button, a one-cell `<table align="center">`, stands in the middle.

**Text:** `font` and its longhands (the generic `monospace`, as the whole
of a family list, at 13/16 of the size the others take, as in a
browser), the families a document brings with `@font-face`
([Fonts](#fonts)), the `font-variant` longhands,
`font-kerning` and `font-feature-settings` (the font's own OpenType
features: small capitals where the font has them, none synthesized),
`text-shadow` (any number, blurred or hard), `line-height`, `text-align` (with
`justify`: a line but a paragraph's last, or one a forced break ends, is
widened at its spaces to fill its box; a line that does not wrap is
aligned in its box as well, and one too long for it overflows its end),
`text-indent`, `text-transform`, `letter-spacing` and `word-spacing` (the
first is the text engine's; the second is spacing added to each space and
no-break space, so only text that asks for it is split into more runs),
and a space that justification or `word-spacing` widens keeps the
kerning it makes with the letters beside it, since spacing is in
addition to kerning, while the text of an element with its own
`letter-spacing` is shaped apart from its neighbours, as a browser
shapes it (on ntk's engine; CoreText drops a spaced glyph's pairs),
`white-space` (including
`pre` and `pre-wrap`, on an element as well as on its block: a `nowrap`
element's text stays together, at its hyphens as well as its spaces, and
`pre`'s spaces take their room at a
line's end, where other spaces hang; `pre-wrap`'s hang there, past the
line and inside their element's background, and take room before a
forced break where they fit; and tabs go to their stops, every
`tab-size` spaces; a line break straight after `<pre>`'s
start tag is dropped, as HTML's parser drops it) and CSS Text 4's halves
of it, `white-space-collapse` and `text-wrap-mode`, `text-wrap` (Tailwind
4's `text-nowrap`, and `text-balance`: a heading of up to six lines broken
at the narrowest width that keeps as many of them, and set in its whole
width, as Chrome does it; `pretty` wraps as `auto` does), `line-clamp`
(CSS Overflow 4: a line-clamp container shows the first lines of its
formatting context, counted through the blocks in it, and is as tall as
they are; what comes after them is invisible and takes no room, and the
last line ends in an ellipsis where more follows, placed after the words
that fit beside it. Tailwind's `line-clamp-2` writes it as
`-webkit-line-clamp` on a vertical `-webkit-box`, the one place that form
clamps, as in a browser; `line-clamp: auto` shows as many lines as the
box's `height` or `max-height` holds, and `max-lines`, `continue` and
`block-ellipsis` are read. A block laid out a line at a time, around an
image or a float, is cut with no ellipsis),
`text-overflow: ellipsis` on a `nowrap` block that clips (`truncate`: each
line cut where the box ends, inside a word if need be, with an ellipsis, as
a browser cuts it), `overflow-wrap` (a word too long for
its line runs past the line's end, as in a browser, unless the paragraph
says it may be cut: `overflow-wrap: break-word` or `anywhere`,
`word-break: break-all` or `break-word`, or `line-break: anywhere`, all of
which cut it where the line runs out; the text engine answers for a whole
paragraph, so an element in it that asks has its every word cut, and text
in a script written without spaces is cut regardless, as the engine finds
no words in it — CoreText, on macOS, cuts a word too long whatever the
style says), `direction`,
`unicode-bidi`, `vertical-align`,
`text-decoration` in all five rule styles, with `text-decoration-thickness`
and `text-underline-offset`. `unicode-bidi` is carried out as
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
any counter style, and `open-quote`/`close-quote` over `quotes`. An
image is asked for through `onResource`, as a background image is, and is
an inline image in the pseudo-element's line, of its own size once it
arrives and of none before.
`counter-reset`, `counter-increment` and `counter-set` are scoped as CSS
Lists 3 scopes them, `reversed()` included, so numbered headings and nested
outline numbers come out as they do in a browser. The generated text is part of the document's text, so a selection
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

**Lengths:** `px`, `em`, `rem`, `ex`, `ch`, `lh`, `rlh`, `vw`, `vh`,
`vi`, `vb`, `vmin`, `vmax` — and the small, large and dynamic viewports'
`svh`, `lvw`, `dvmin` and the rest, which on a desktop are the one
viewport — and the absolute units, and `calc()`, `min()`, `max()` and
`clamp()` over them (CSS Values 4). An `ex` is the font's x-height and a
`ch` the advance of its "0", as the text engine reports them, or half an em
where it cannot say; an `lh` is the element's line height, `normal` as its
font's own, and an `rlh` the root's. A math function comes down to pixels and a percentage, which
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
colour is used. `light-dark()` takes its first colour where the element's
colour scheme is light and its second where it is dark (CSS Color 5), in
any value a colour stands in, a custom property's included. The scheme is
the element's `color-scheme` resolved against the react-x11 palette's in
force, which stands for the reader's preference: `light dark` follows the
palette, `light` or `only dark` holds whatever it is, and `normal` — the
initial value — is the palette's own, since the palette is this renderer's
default look. The scheme picks nothing else: where a browser also turns
its canvas and its own colours dark, the canvas here is the palette's
whatever the page says. Relative colours and the system colours are not read, and a
declaration using one is dropped, as a browser that did not know them
would drop it.

**Selectors:** everything [css-select] supports — combinators, attribute
operators, `:nth-child(an+b)`, `:not()` — plus `:hover`, which is answered
from this renderer's own pointer state. `:focus`, `:focus-visible` and
`:focus-within` match nothing: no element of the document takes the focus,
a control's widget does, beside it. So `:not(:focus)` holds, and
Wikipedia's skip link, hidden with it, stays hidden. Escapes are read wherever they stand,
so a Tailwind class such as `md:flex`, written `.md\:flex`, matches. A group
with a selector in it that is not one — an unknown pseudo-class, a name that
starts with a digit — is dropped whole, as CSS 2.1 drops it. Rules nest
(CSS Nesting 1): a rule inside a rule's block is relative to it, `&`
standing for it and a selector without one a descendant, and an `@media`,
`@supports` or `@layer` inside one holds for the same element, which is how
Tailwind 4 writes its `hover:` and `md:` variants. `@media` width and
`prefers-color-scheme` queries are evaluated, widths in Media Queries 4's
ranges, `(width >= 48rem)`, as well as `min-width`, a `calc()` in a value
too — the scheme is the react-x11
palette's in force, so a `<ThemeProvider colorScheme>` above the element
answers it and a desktop that switches schemes re-cascades the document.
`@import` goes through the resource seam. Cascade layers are read (CSS
Cascade 5): `@layer a, b;` fixes their order, the document's across all of
its sheets, and a rule in a later layer wins over one in an earlier layer
whatever their specificity, a rule in no layer over both, and the other way
round for `!important`. Tailwind 4 writes all of its CSS in four of them.

**Not implemented:** the parts of CSS grid above, transforms but their
translation, animations and transitions, multi-column, gradients other than
linear ones, a sticky box that follows the viewport as it scrolls, and the font
properties of `::first-line`. A `<col>`'s or a `<colgroup>`'s borders are
drawn only where the table's collapse. A percentage `height` resolves where
the containing block's height is set, and on an absolutely positioned box.
The initial containing block is the viewport: the box that scrolls the
element, where one does — a browser's page area, under its tabs and its
toolbar — and the window where nothing does, since the element sizes to its
content. So `html, body { height: 100% }` is a viewport tall and `bottom: 0`
with nothing positioned around it is the viewport's bottom, as in a browser;
the document is as tall as what overflows its root, so nothing longer than
the viewport is cut off — an inline element's padding and border below its
line among it, as a browser counts them, where nothing clips them. A document that reads the viewport's height — a
`vh`, a percentage height on the root, a box placed against the initial
containing block — follows it when the window is resized, a frame behind
the scroll box it is measured by; one that reads none is not laid out again
when only the height moved. A `position: fixed` box and a
`background-attachment: fixed` background stay where that viewport is as
the box scrolls the element: laid out against it at the document's top,
drawn where it is now, and found there by the pointer. The element tells
the scroll box what it draws that way (react-x11's `viewportFixedRects`),
so a scroll that copies the pixels it can repaints those where they are
rather than dragging a fixed header along with the text; a fixed
background, behind the whole viewport, makes every scroll a repaint. A fragment has no
root element, and its blocks have the body's `auto` height to resolve
against.

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
it _is_ one; the same goes for checkboxes, radios, text fields and
`<input type=submit>`. They mount as absolutely positioned siblings of the
element, at the rectangles layout reserved for them — the escape hatch
[`<Flow>`](flow.md) opened for a node whose body is a form. A drawn control
would take no focus, say nothing to a screen reader, and have to reimplement
every keyboard convention the platform already has.

A widget is drawn at the opacity its element and every ancestor come to,
and at 0 not at all while it still takes a press, as the element does in a
browser: a CSS-only dropdown lays an invisible checkbox over its label, and
a press anywhere on the label opens it, since a checkbox's widget takes its
element's whole box. A `visibility: hidden` control is not mounted.

A `<button>` is the exception, because its content is the document's: an
icon, a label in spans, a pill of the page's own design — most of the
buttons on the web — which a widget's text label drew as "Button". It is
laid out and drawn like any box, in the palette's control look where the
page leaves it alone, and a press on it is reported through
`onControlChange`, with its `value`, as a widget's is; it takes no focus of
its own. Its text, like every control's, keeps none of the letter and word
spacing, the line height, the case, the indent or the shadow of the text
around it, as HTML's rendering section has it: a button in a body of
`line-height: 1.5` is its own font's line tall.

**A text field the page styled is the page's to draw.** Give an `<input>` or
a `<textarea>` a border or a background of its own, or `appearance: none`,
and the document paints that box, as a browser drops a field's native look
for the author's; the widget is mounted bare inside its content box, with no
frame or fill, and writes in the element's own colour and font, which the
author chose to go on that background. Its size is then its text's, and the
border and padding around it are the author's. `appearance: none` is how a
design system writes every field it has, often with neither a border nor a
background. A field with none of the three keeps the theme's frame, and so
does every `<input type=submit>`: core's `<Button>` draws its own label.

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
a bug rather than as a missing element. The implied `<html>` has no box of
its own, so what it does not pass down is drawn only where it can be: its
background covers the canvas, and the body keeps its own. The root box is as
tall as the body says where that is definite, as `html, body { height:
100% }` makes it a window tall. A `<body>` with no `<html>` around
it, which is how a lot of mail starts, is still the body: its background
covers the whole canvas. A document that writes `<html>` gets the body
element HTML's parser would have made — the first thing in it that is not
head content opens one — and content before a written `<body>`, or after
it ends, goes in the body, as a browser puts it there. A `/>` closes an
element only where HTML's parser says it does, on a void element and in
SVG and MathML: a `<div/>` opens a div, as it does in a browser, and XHTML
that means it closed has to be handed over as HTML, its `/>` written out.

**The user-agent stylesheet is themed.** `color`, the link colour and every
rule and border in it come from the react-x11 palette, so an unstyled
document dropped into a dark application arrives dark rather than as a white
rectangle. An author stylesheet still overrides all of it.

**`:hover` costs nothing unless the document uses it, and ink where it
changes ink.** A pointer move only restyles when some selector in the
document actually tests `:hover`, which is why the user-agent sheet
deliberately has no `a:hover` rule. And it restyles where it happened: only
an element whose hover state flipped, and that a compound testing `:hover`
could match, is styled again — with its subtree, and its later siblings
where `+` or `~` follows — so a move between two paragraphs under `a:hover`
does nothing at all. Where all a move changed is ink — a colour, an
underline, a background or a border's colour, as 77 of a Wikipedia
article's 79 such rules change — the boxes take their new style and each
paragraph's text is laid out again from the same runs with the new ink, at
the same shape, and nothing else is built or laid out: a hover over that
article went from 270 ms to under 15 ms on X11, and from about 800 ms to
17 ms on macOS. A card's hover goes the same way where what else it changes
moves nothing around the card: a `box-shadow` or an outline's size, which
reach further and take no room; a `z-index` that stays a stacking
context's, which reorders the card's layer; and a `transform`'s
translation, which moves the card and what is in it where it is — so the
card lifts, its shadow widens and it rises over its neighbour without the
document being built or laid out again. The repaint is the ink that
changed, what the boxes drew before and what they draw after, not the
document: on Zen Garden's list of designs, whose cards do all three, a
scroll under a still pointer went from 32 to 46 frames a second at 2x on
macOS. Anything else builds the document again, as every hover used to —
text set bold on hover, a pseudo-element or a list marker the element
colours, a translation that would make a box the containing block of
what is in it, a `:hover` inside `:not()` or `:has()`. `:active` is never
set here, so a selector testing it changes nothing as the pointer moves.

**The cursor is the document's.** Over a link it is the `pointer` the
user-agent sheet gives `a[href]`, wherever a page writes `cursor` it is
what the page wrote, and where nothing says, it is the text I-beam over
text and the arrow elsewhere, as a browser shows them. Core asks the
element for the point as the pointer moves (`cursorAt`, react-x11#757): a
document is one node with a cursor for each part of it. A `url()` cursor
is not loaded, and falls back as its list would.

**What is under the pointer is what was painted there last.** The cursor,
the hover, `elementAt` and `hrefAt` share one hit test. It reaches every
place a box draws, including what overflows it, as long as the box does
not clip. So a page that sets `html, body { height: 100% }` and runs longer
than that still has links below the first screen. A clip hides only what
it holds, not a positioned box whose containing block is outside it, and
paint draws such a box past the edge. The hit test finds it there too:
the Zen Garden's archive links are absolute items in an `overflow: hidden`
list that has no height of its own. Where two boxes overlap, the answer
follows CSS paint order, `z-index` included. An infobox floated out of
one section and hanging over the next keeps its links, and the next
section's box does not take them.

**Nesting is capped at 256 elements, as Blink's parser caps it at 512.**
Everything from the cascade to paint recurses on tree depth, so a
degenerately nested document — a few hundred unclosed `<div>`s, a runaway
template — would otherwise be a stack overflow far from its cause. The
parser puts what is opened deeper into the element at the cap, as Blink's
does, so what is lost is the nesting and not the content; and the box
builder still stops at 512 boxes, for the anonymous boxes a table builds
round each level. Documents this deep are not documents.

**Lengths are kept to what a browser holds.** A length is ±33,554,428
pixels at most, as a browser holds one and as `calc()` already made an
infinity, and a font size 10,000 pixels, as Chrome keeps it: a `1e308px`
height added up to an infinite document, and a text engine handed a face
millions of pixels high shapes and caches glyphs that size.

**A document that cannot be laid out or painted is left blank.** What
still throws — the limit of a text engine or a server that one more
document finds — does so from a paint, where a throw is the application's
end, for a document it did not write. It is caught, the document is left
blank, and the error is reported once through `console.error` outside
production; a change to the source, or the width, tries again.

**A character the text engine cannot shape is drawn as U+FFFD.** The engine
picks the face a character is drawn in, and it can pick one its shaper has
no glyphs in: a bitmap-only colour emoji font (`CBDT`) — what fontconfig on
most Linux desktops answers first for an emoji — has no outlines fontkit
can make a glyph from, and the shaper throws. That used to be the whole
document left blank, for an emoji in a heading. A layout that throws is now
tried again with each character that cannot be shaped in its run's face
drawn as U+FFFD (a character past the BMP as U+FFFD and U+FE0F, the same
length in UTF-16), found by laying each out alone and remembered per face.
The document's text is untouched — selection, copy and the accessors see
the page's own characters — and the first stand-in is reported once through
`console.warn` outside production.

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
height where the document reads it. A `vw` or a `vh` is a number once
computed, so a document whose styles use one is restyled when that side of
the viewport moves, and one that uses neither skips the cascade on a resize
as before. Only a size comes from it; paint and the selection read the boxes,
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

**A document's faces are asked for as soon as its boxes say which.** A face
the application had not set text in before was a synchronous `fc-match`
inside the layout that first reached it: the benchmark report's `th`, at
600, waited 38 ms before its first paint. The box build now keeps the
styles its text is set in, and every face among them the fonts have not
been asked for is warmed before layout starts (ntk's `FontManager#prewarm`),
in one child process for all of them, off the event loop. A layout that
reaches a face still on its way takes the answer rather than asking again.
The report's first paint went from 954 to 928 ms on X11, and an edit pays
about 0.15 ms for keeping the styles. Where the fonts have nothing to look
up, a native text engine or faces handed over in memory, the call does
nothing.

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

```bash
npm run examples:browser -- [url]
```

The other end of the seams: a tabbed web browser, and a network. `<Tabs>`
is its strip, and each tab a toolbar over a page that runs in a process of
its own — core's `<Frame>`, with `page.tsx` as the pane — so a page that
throws, wedges or grows without bound costs its own tab and nothing else.
In the pane an `<Html>` is given the page's URL as `baseUrl`, and
[`examples/browser/`](../../examples/browser/) is the host a document's
requests go to — the page streamed in as it arrives, then every stylesheet,
image and `@font-face` font through `onResource`, a few requests a host at a
time. A tab shows the page's `<title>` and its icon; Ctrl+T (⌘T on macOS)
opens one. It is where the component's policy — nothing fetched, nothing
run — meets an application's: the browser fetches what a page asks for and
runs none of its scripts.

[domhandler]: https://github.com/fb55/domhandler
[domutils]: https://github.com/fb55/domutils
[css-select]: https://github.com/fb55/css-select
