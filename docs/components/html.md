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

| Member            | What it is                                                            |
| ----------------- | --------------------------------------------------------------------- |
| `document`        | The live DOM — [domhandler]'s tree, which [domutils] speaks natively. |
| `refresh()`       | The DOM changed: restyle, re-lay-out, repaint.                        |
| `elementAt(x, y)` | The element under a point, in the window's coordinates.               |
| `title`           | The document's `<title>`, if it had one.                              |

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

Return `{ kind: 'image', image, width, height }` instead to hand over an
image the host decoded itself. A declined or absent resource is an ordinary
state: images draw as a frame at their attribute size, and linked stylesheets
are skipped.

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
open web.

**Layout:** block flow with margin collapsing, inline formatting with
bidi and full shaping, `inline-block`, floats and `clear`, lists with their
markers, tables (the auto algorithm and `table-layout: fixed`, with `colspan`
and `rowspan`), `position: relative | absolute | fixed`, and `display: flex`.

**Boxes:** `width`/`height` with `min-`/`max-`, `margin`, `padding`,
`border` (width, style, colour, radius), `box-sizing`, `overflow`,
`opacity`, `visibility`, `z-index`.

**Text:** `font` and its longhands, `line-height`, `text-align`,
`text-indent`, `text-transform`, `letter-spacing`, `white-space` (including
`pre` and `pre-wrap`), `direction`, `vertical-align`, `text-decoration` in
all five rule styles.

**Selectors:** everything [css-select] supports — combinators, attribute
operators, `:nth-child(an+b)`, `:not()` — plus `:hover`, which is answered
from this renderer's own pointer state. `@media` width queries are
evaluated; `@import` goes through the resource seam.

**Not implemented:** CSS grid (degrades to block stacking), transforms,
animations and transitions, multi-column, shadows, gradients, and
`position: sticky` (treated as `relative`). `border-collapse: collapse` is
drawn as the separate model with zero spacing.

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
element: the `TextRun` vocabulary ntk's text layout takes, the per-run
decoration painter, and the bidi-correct selection bands. See
[richtext](richtext.md).

**Form controls are real widgets, not pictures of them.** A `<select>` in a
document drops the same menu as a `<Select>` in the window around it, because
it _is_ one; the same goes for `<button>`, checkboxes, radios and text
fields. They mount as absolutely positioned siblings of the element, at the
rectangles layout reserved for them — the escape hatch [`<Flow>`](flow.md)
opened for a node whose body is a form. A drawn control would take no focus,
say nothing to a screen reader, and have to reimplement every keyboard
convention the platform already has.

**The application scrolls it.** The element sizes to its content; put it in a
`<box overflow="scroll">`, the same shape `<Markdown>` uses. That keeps the
mounted controls scrolling with the document for free, and core's scroller
already blits. A document taller than X11's 16-bit coordinate space needs the
element to scroll itself, which is phase-2 work — see [the PRD](../prd-html.md).

**A fragment gets an implied body.** `<p>hi</p>` has no `<body>` element, so
the root box takes the style a `<body>` would have had: the user-agent
margin, the font, and any author `body { … }` rule. Without it the same
markup renders differently inside and outside `<html><body>`, which reads as
a bug rather than as a missing element.

**The user-agent stylesheet is themed.** `color`, the link colour and every
rule and border in it come from the react-x11 palette, so an unstyled
document dropped into a dark application arrives dark rather than as a white
rectangle. An author stylesheet still overrides all of it.

**`:hover` costs nothing unless the document uses it.** A pointer move only
restyles when some selector in the document actually tests `:hover`, which is
why the user-agent sheet deliberately has no `a:hover` rule.

## Streaming

`partial` works the way `<Markdown partial>` does, and rather better: the
parser is a real streaming one, so a `source` that extends the last one is
written as a **delta**. The nodes already parsed keep their object identity,
which means their computed styles, their boxes and their laid-out lines
survive; only the tail is new work. A `source` that is _not_ an extension
resets the parser, because a mid-document edit can change the tree
arbitrarily.

Set `partial={false}` when the stream ends.

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
descendants draw, so an expose of a 40-pixel strip in a very tall document
touches only the boxes that overlap it. And a paragraph is one glyph batch:
ntk's text layout draws all of its lines in a single composite.

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
what it was handed without running it.

[domhandler]: https://github.com/fb55/domhandler
[domutils]: https://github.com/fb55/domutils
[css-select]: https://github.com/fb55/css-select
