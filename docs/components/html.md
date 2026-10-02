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
| `animate`         | `boolean`                                        | Whether CSS animations run. Default true. False draws each as it stands once it has run — see [Animations](#what-renders).                                                   |
| `stylesheet`      | `string \| string[]`                             | Author stylesheets applied after the document's own, so a host can restyle a document it does not control.                                                                   |
| `charset`         | `string`                                         | The encoding the host decoded `source` from, as a label (`'shift_jis'`). A stylesheet handed over as bytes that names no encoding of its own is in it. Default UTF-8.        |
| `baseUrl`         | `string \| null`                                 | The URL the document came from. With it, every URL reaches `onResource` and `onLink` absolute — see [Base URLs](#base-urls). Absent, URLs are handed over as written.        |
| `onResource`      | `(r: ResourceRequest) => ResourceResult \| null` | An `<img>`, a `<link rel=stylesheet>`, an `@import` or an `@font-face` font wants loading. May return a promise. **Absent, nothing loads.**                                  |
| `onScript`        | `(s: ScriptRequest) => void`                     | A `<script>` was found, handed over unparsed and unevaluated.                                                                                                                |
| `onLink`          | `(href, ev) => void`                             | A link was activated — clicked, or Enter on it — see [Focus and the keyboard](#focus-and-the-keyboard). Absent, nothing follows it: this never navigates by itself.          |
| `onDocument`      | `(document: Document) => void`                   | The parsed DOM, each time it is re-parsed.                                                                                                                                   |
| `onControlChange` | `(element, value) => void`                       | A form control changed, or a `<button>` was pressed, with its `value`. The element is the one in the DOM.                                                                    |
| `onSubmit`        | `(submission: FormSubmission) => void`           | A form was submitted, handed over as the request it makes — see [Forms](#forms). Absent, submitting does nothing.                                                            |
| `fontSize`        | `number`                                         | Base text size. Default: theme `fontSize`, or 14. Form controls stay at the theme's.                                                                                         |
| `fontFamily`      | `string`                                         | Default `'sans-serif'`. Form controls stay in the theme's.                                                                                                                   |
| `monoFamily`      | `string`                                         | Code font, and a `<textarea>`'s. Default `'monospace'` — there is no theme token for it.                                                                                     |
| `selectionColor`  | `string`                                         | Selection band fill where no `::selection` rule reaches the text. Default: theme accent at 35% opacity.                                                                      |
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

| Member                 | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `document`             | The live DOM — [domhandler]'s tree, which [domutils] speaks natively.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `refresh()`            | The DOM changed: restyle, re-lay-out, repaint.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `elementAt(x, y)`      | The element under a point, in the window's logical coordinates — the ones a mouse event's `x`/`y` carry.                                                                                                                                                                                                                                                                                                                                                                 |
| `hrefAt(x, y)`         | The link under a point, resolved as `onLink` is handed one — for a status bar, or a menu on a link.                                                                                                                                                                                                                                                                                                                                                                      |
| `elementRect(element)` | Where an element is, in logical pixels from the document's top left — the space a scrolling box's offset is in. A block's border box; an inline element's across its fragments, padding and border included, as `getBoundingClientRect` measures it, and as tall as its lines — and, where a block inside it broke it in pieces, across the lines of those blocks too, from where clearance moved a block down from, as a browser's is. Null for an element with no box. |
| `title`                | The document's `<title>`, if it had one.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `base`                 | What the document's relative URLs resolve against — its `<base href>`, or `baseUrl` — or null.                                                                                                                                                                                                                                                                                                                                                                           |

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
imports itself, or one of the sheets importing it, is read once. An
import's media queries — `@import url(wide.css) (min-width: 800px)` — are
conditions on the sheet it brings in, as though an `@media` block were
around all of it (CSS Cascade 4, 2): the sheet is asked for once, whatever
the width, and its rules hold where the queries do, a resize across one of
their breakpoints restyling as it does for `@media`. One that can hold
nowhere here, `print`, is not asked for.

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
browser: a face loads when a computed style wants its family at its width,
weight and slant, the nearest face to them as CSS Fonts 4 matches one, and
when a character of the document falls in its `unicode-range`. A Google Fonts sheet
declares a family once per script and a self-hosted family often declares
every weight it has; a page that uses two weights of the Latin half asks for
two files. The sources are tried in order: one whose `format()` is not a
font a text engine reads (`embedded-opentype`, `svg`) is passed over, and so
is one the host declines, one whose bytes are not a font, and one the engine
reads and cannot set text in, below.

**A WOFF2 is a font on every backend.** It is what the web serves — most
pages name no other format — and not every text engine reads the container:
ntk does, and CoreText reads an sfnt and nothing else, so react-x11's
`loadFont` refuses a WOFF2 on macOS. A page's fonts were never
set there: nextjs.org was set in Arial, the family its fallback's `local()`
names, where a browser sets it in Geist. So a file is offered to the engine
as it was served, and a WOFF2 the engine turns down is offered again as the
font inside it — its tables out of their Brotli stream, and `glyf`, `loca`
and `hmtx` put back from the form the format stores them in (WOFF 2.0, 5) —
which every engine reads. Nothing asks which engine it is. What is rebuilt
is the font and not the file it was made from: the outlines are the same
points, packed again. A collection (`ttcf`) is not rebuilt, and neither is
anything on a runtime with no Brotli — node and Bun both have one — and
such a source is one that did not load.

Until a face has loaded its family is left out of the list, and the text is
set in the next family the author named, as `font-display: swap` has it;
when it arrives the document is set again. That holds for a family none of
whose faces ever loads: a family the document declares is never looked up on
the system by the name the document gave it (CSS Fonts 4, 5.2), so
`font-family: Mine` with a declined `@font-face` is the document's default
and not whatever a text engine finds nearest to `Mine`.

**A `local()` is the system's family of that name.** It is a source like a
`url()`, tried in its place in `src`, and nothing is asked of the host for
it:

```css
@font-face {
  font-family: 'GeistSans Fallback'; /* next/font's stand-in for Geist */
  src: local('Arial');
  size-adjust: 106.28%;
}
h1 {
  font-family: GeistSans, 'GeistSans Fallback';
}
```

Until `GeistSans` arrives the list is `Arial`, and after it the private name
of the loaded face, then `Arial`. CSS has `local()` name one face, by its
full name or its PostScript name; a font manager finds fonts by family, so
the name is matched as one, and counts as found only when the face that
comes back carries it — a guess at a name nobody has is not a match. The
usual spellings are a family's regular face, whose full name is the family's
(`local(Arial)`, `local("Times New Roman")`), and those are found. A face
named with its style (`local("Arial Bold")`, `local(Arial-BoldMT)`) mostly
is not, and the face falls to its next source, or its family out of the
list. What the list gets is the family, and the text engine picks the face
in it by the weight and slant of the text: bold text in the family above is
set in Arial Bold, where a browser emboldens the one face the rule named.

The descriptors that adjust a face's metrics — `size-adjust`,
`ascent-override`, `descent-override`, `line-gap-override` — are not read,
so a fallback tuned to take the room of the font it stands in for takes its
own.

**A variable face is set at the weight its rule has for a style's.** The
weight a style asks for is a place on a variable font's `wght` axis, clamped
to the range the face's `@font-face` declares (CSS Fonts 4, 7.2):

```css
@font-face {
  font-family: Geist;
  src: url(geist.woff2);
  font-weight: 100 900; /* every weight the file has */
}
@font-face {
  font-family: Part;
  src: url(geist.woff2);
  font-weight: 400 500; /* text at 900 is set at 500, at 100 at 400 */
}
```

The rule is the document's, so the value is the component's to say, and it
hands it to the engine with each run whose list leads with such a face — a
run's `variations`, which both engines take. Left to itself an engine either
moves the axis to the style's weight, past a rule that declared less of it
(ntk), or does not move it at all: a face registered with CoreText is drawn
at its file's default, and every heading of a page set in a variable font
was the regular on macOS. A rule that declares one weight, or none, says
nothing about an axis, and its face is set as the engine sets it. A browser
also emboldens a face asked for a weight past its range — the 900 above —
and that is not done: the text is the 500. A form control's text is its
widget's, which is handed the family and the weight and no axis.

**And at the width.** `font-stretch` — a keyword or a percentage — is a
place on a variable font's `wdth` axis, clamped the same way to the range
the face's rule declares, and where it declares none (`auto`) to nothing but
the file's own range (CSS Fonts 4, 4.4):

```css
@font-face {
  font-family: Archivo;
  src: url(archivo.var.woff2);
  font-weight: 100 900;
  font-stretch: 62% 125%;
}
.display-x {
  font-family: Archivo;
  font-weight: 900;
  font-stretch: 62%; /* wght 900, wdth 62 */
}
```

No text engine knows a width, so this one is the component's whichever
engine draws: a run whose list leads with such a face carries it in its
`variations` beside the weight, wherever it is not the file's default — a
page whose variable fonts are only ever set at their normal width hands the
engine what it did before. bun.sh's headings, in Archivo at 62% and 75%,
were set at its normal width, half as wide again as a browser sets them,
and wrapped onto lines Chrome does not have. A `ch` is the advance of the
`0` at the text's width. The `font` shorthand takes a width as a keyword
(`condensed`), not a percentage, and sets it back to normal where it names
none.

**A family's faces of several widths are matched by the width first.** CSS
Fonts 4 (5.2) narrows a family's faces by width, then slant, then weight: at
or under normal width the nearest narrower face, then the nearest wider;
over it the other way round. A family that declares a condensed face beside
its regular sets text at 80% in the condensed one, whatever its weight, and
asks for that file only when there is such text. The font manager picks
among one name's faces by weight and slant alone, so the faces of each width
are registered under a name of their own, and each run is handed the list
with its width's name first. A family the system has is the engine's to
match, and neither engine matches by width: `font-family: "Helvetica Neue";
font-stretch: condensed` is set at the family's normal width.

Two `@font-face` values are read as the spec has them, as Firefox reads
them, where Chrome does not: a range with a keyword in it (`font-stretch:
condensed expanded`), which Chrome and Safari drop, and `font-stretch:
normal`, which Chrome reads as `auto`. `font-width`, the property's newer
name, is not read: of the three browsers only Safari does.

**A face the text engine cannot set costs its family, not the document.**
A variable font is drawn by cutting an instance out of it, and ntk, the
engine on X11 and Wayland, cuts one for the weight and the size a style asks
for with fontkit — which, as released, cuts none out of a WOFF or a WOFF2,
the containers a variable web font is served in. The throw came out of the
first text layout in the family at any weight but the file's default, and
the document was left blank: nextjs.org's blog, for the first bold word set
in Geist. So a face is asked for an instance once, before it is registered,
and one that refuses is turned down as one the engine cannot read is: a
WOFF2 is offered again as the font inside it, which is cut without trouble,
and anything else is a source that did not load — the next is tried, and
with none left the family stays out of the list, as a browser leaves out a
font it cannot use. That is said once a connection, in development, with the
engine's own reason. CoreText and DirectWrite move an axis themselves and
are not asked.

**A list that no face matches ends in the document's font.** A
`font-family` list an author wrote that does not end in a generic family
(`serif`, `monospace`, `system-ui` and the rest) has the document's own
family, the `fontFamily` prop, after it: where nothing the author named is
installed, the text is set in the user agent's default font (CSS Fonts 4,
5.1), as a browser sets it in its standard font — not in whatever the text
engine picks for a name it has never heard of, which under fontconfig is
its own default. A list that ends in a generic falls back through that, and
the UA sheet's own families, the palette's face a control is set in and
`monoFamily`, are the host's and stay as they are given.

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

## Forms

```jsx
<Html
  source={page}
  baseUrl={url}
  onSubmit={(s) =>
    s.method === 'get'
      ? navigate(s.url)
      : post(s.url, s.body, { 'content-type': s.contentType })
  }
/>
```

**A form is a link it writes itself, and `onSubmit` is `onLink` for it.**
Pressing a submit button — an `<input type=submit>`, a `<button>`, an
`<input type=image>` — or pressing Enter in a text field works out what a
browser would send and hands it over, sending nothing: whether a POST goes
anywhere is the host's to decide, as whether an image loads is. Without
`onSubmit` a form submits nothing, and is not checked either.

| Member        | What it is                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `form`        | The `<form>` element.                                                                                                                                                                               |
| `submitter`   | The button that submitted it, or null for Enter in a form that has none.                                                                                                                            |
| `method`      | `'get'` or `'post'`.                                                                                                                                                                                |
| `url`         | The `action`, resolved as `onLink`'s `href` is — against the document's base, and an empty one is the document's own URL. A GET's has the entries as its query, so a GET is a link to exactly this. |
| `enctype`     | `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`.                                                                                                                         |
| `entries`     | The `[name, value]` pairs, in tree order, unencoded.                                                                                                                                                |
| `body`        | A POST's body, encoded as `enctype` says; null for a GET.                                                                                                                                           |
| `contentType` | The `Content-Type` for the body — `multipart/form-data`'s names its boundary; null for a GET.                                                                                                       |
| `target`      | `formtarget`, `target` or `<base target>`: `'_blank'` asks for a new browsing context, empty for this one.                                                                                          |

What goes in `entries` is HTML's entry list (HTML 4.10.21.4): every control
the form owns — inside it, or anywhere with a `form` attribute naming it —
that is enabled (not `disabled`, and not in a disabled `<fieldset>` outside
its first `<legend>`) and has a `name`; checkboxes and radios only when
checked, with `on` where they have no `value`; a `<select>`'s selected
options, the first one where none is marked; the button that submitted it
and no other, and an image button as `name.x` and `name.y`, the point it
was pressed at; `_charset_` and `dirname` as HTML fills them in. What was
typed into a field is in them, sanitized as its type says — no line breaks
in a single-line field, no white space around an email, nothing in a number
field that is not a number. The button's `formaction`, `formmethod`,
`formenctype` and `formtarget` win over the form's own; `method="dialog"`
submits nothing.

Enter submits as a browser's does (HTML 4.10.21.2): by the form's first
submit button, and with none only when the form has at most one text field,
since Enter in one of several would be a guess. A reset button puts every
control the form owns back as its markup had it, typed text included. A
press on a `<label>` is one on its control: a box is toggled, a radio
checked, a button pressed and a field focused. The first control with
`autofocus` is focused once the document is up — where nothing else in the
window holds the focus, since a page never takes the keyboard from the
application around it.

**A form that breaks its own constraints does not submit, and says why.**
`required`, `minlength`, `maxlength`, `pattern`, `min`, `max`, and an email
or a URL that is not one stop the submission at the first control that is
wrong: it takes the focus, and the reason — in a browser's words, "Please
fill out this field." — is shown under it for a few seconds, or until the
control changes. `novalidate` on the form, or `formnovalidate` on the
button, turns it off. A length is checked only once something has been
typed, as HTML checks it, and `maxlength` is also the most a field takes as
it is typed into.

**Encoded in UTF-8, always.** A browser encodes a form in the document's
own encoding, or its `accept-charset`, so a Shift_JIS page's form sends
Shift_JIS; this has no encoder but UTF-8, and says so in `_charset_`. A
page in a legacy encoding that takes non-ASCII input needs the host to
re-encode `entries` itself.

**A file field sends no file.** `<input type=file>` is a text field here,
and a submission carries it as a file with no name and no content, as a
browser does when none was chosen. Reading a file is a host's business,
through a dialog of its own; nothing here reaches the disk.

**What was typed lives beside the DOM, not in it.** HTML's `value`
attribute is a field's _default_ — what a reset puts back — and a
`<textarea>`'s is its content, which is not an attribute at all, so the
typed text is kept by the component, per element, and a widget mounted
again (its element hidden and shown) comes back with it. An `<input>`'s is
also written to its `value` attribute, as it always was, for a handler that
reads it off the element. A checkbox, a radio and a `<select>` do keep what
they hold in the DOM — `checked` and `selected` — because `:checked` is a
selector documents really use.

## Focus and the keyboard

**Tab goes through a document as it goes through a page in a browser**: its
links, its buttons, its summaries, its controls and whatever a `tabindex`
makes focusable, in the order the markup has them, into the document from
the window's control before it and out of it to the one after. Shift+Tab
goes back. A link that is a preview — an `<a>` round an `<img>` — is a stop
like any other.

What is focusable is HTML's (6.6.3), as Chrome reads it: an `<a>` with an
`href`, a `<button>`, an `<input>` that is not hidden, a `<select>` and a
`<textarea>` that are not disabled — in a disabled `<fieldset>` outside its
first `<legend>` they are — a `<details>`' summary, and any element with a
`tabindex`. Of those, the ones that are rendered: an element with no box —
`display: none`, or in a closed `<details>` — is passed, and so is one that
is `visibility: hidden` or `inert`, or inside one that is. A negative
`tabindex` keeps an element out of the order and leaves it focusable. A
positive one is read as zero, as it is on a control's widget: it would put
a page's element ahead of the application's own, and the order between a
document and the window around it is not the document's to set.

**The focus is the document's to draw.** The element Tab reaches is
`:focus` and `:focus-visible`, and every element around it `:focus-within`,
so a page's focus styles show — the Zen Garden's `a:focus`, a 5px outline
with its corners rounded, and its previews' lift and glow. Where the page
says nothing, the UA sheet's `:focus-visible { outline: auto 1px
-webkit-focus-ring-color }`, Chrome's, draws the palette's ring round the
element's border box, or round each of a link's fragments. A press does not
focus a link or a button, which it does in a browser: the press focuses the
document, whose selection Ctrl+A and Ctrl+C belong to, and a click on a
link follows it. Tab after a press goes on from where it landed, as from a
link pressed or from text between links, which is HTML's sequential focus
navigation starting point (6.6.4). The element focused is scrolled into
view, by the box around the document that scrolls.

**Enter follows a link, with a click.** A browser activates a link from the
keyboard with a `click` (HTML 6.5.6), and so does this: `onLink` is handed
the link's `href` and a `MouseEvent` whose `detail` is 0, with the key's
modifiers — Ctrl+Enter is Ctrl+click — and its point the middle of the
link's first fragment, so a handler that asks what is under the click
(`handle.elementAt(ev.x, ev.y)`, for a `target="_blank"`) finds the link.
Space is the page's, as it is in a browser, and follows nothing. Enter or
Space presses a `<button>` — reported through `onControlChange` and then
doing what it does, as a press with the pointer does — and an image button,
at its corner. On a summary it opens or closes its details, as a press on
it does: the `open` attribute is the state, so `details[open]` styles it,
and what it shows takes its place in the order. Ctrl+A and Ctrl+C reach the
document's selection from whatever in it has the focus.

**What takes the focus for a drawn element is a box over it.** A form
control's widget takes the focus itself. A link, a `<button>` or a summary
is drawn, and a drawing takes no focus — so each is given a box with no
paint and no hit area, mounted over the element as a widget is, which core
focuses as it focuses any node: that is what keeps a document's stops in the
window's focus order rather than in an order of their own, what scrolls one
into view, and what an assistive technology hears, as a link or a button,
named by its text, its `aria-label` or the `alt` of its image. A page of
links has thousands of them, and a box each would be a node core walks on
every hit test and every paint, so **only a few are mounted**: the
document's first and last stops, where Tab comes in from either side, and
the one focused with the ones either side of it. Tab goes from one to the
next itself, in the markup's order; one it goes to that is not mounted is
mounted and then focused. Where it runs off the end, the window's own order
takes it on out of the document. The cost is the accessibility tree's: an
assistive technology finds the stops that are mounted, not every link.

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
last is its margin edge (CSS Box Alignment 3, 9.2). A scroll container
holds whichever baseline it gives to its border box, at either edge
(9.1), as deep in a box as it is: an inline flex box that clips a line
taller than itself sits on its bottom edge, and one with `overflow: clip`,
which is no scroll container, on its line. A `<button>` sits on
its content's baseline whether it clips or not, and on the bottom edge of
its content box where its content has none, as it does in Blink: a button
of an icon is no taller on its line than it is. A sticky box is placed
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
and the `list-style-type`'s is until then. An image with no size of its
own, an SVG with only a `viewBox`, is fitted into a square half its face's
ascent across, which is Blink's: CSS Lists 3 says 1em, and both engines
find that too large
([w3c/csswg-drafts#4207](https://github.com/w3c/csswg-drafts/issues/4207)).
An image is 7px from the content, Blink's distance, where CSS 2.1 leaves
it to the user agent: between the image and the content's edge outside the
item, and after the image inside it, where the content's own space after
it is kept, as after any image. Blink's 7 is unzoomed, and at a device
scale of 2 Chrome's is 7 device pixels; this one is 7 CSS pixels at any
scale, so that a page at 2x is the page at 1x doubled.
An outside marker that reaches
higher above its baseline than the item's first line does makes room as
Blink does: the line grows where it is the item's own, and where it is in a
block inside the item — a paragraph, a link set `display: block` — the
block goes lower by the difference and keeps its height. A `::marker`
rule sets its colour and its font, and a `content` sets it as that,
counters and all, its white space kept: `counter(list-item) ".\a0"` is
where the default marker is. A list item counts with the
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
its content box's unless `box-sizing` says otherwise. One that may not
shrink stays that wide in a row too narrow for it — `shrink-0` beside
`shrink-0` runs out of the row on one line each rather than wrapping — and
items that may shrink give up the room the row lacks in proportion to that
width times their `flex-shrink`, however much wider than the row it is: a
paragraph beside "Pricing plans" in a row of 300px comes to 245px of it, as
in Chrome. And
one a `min-width` of its own holds wider than the room it is offered, as
`min-w-max` in a narrow row or column does, or its longest word holds in a
row that wraps, is as tall as its content at that width. A table among them
is as wide as the flex layout makes it, as Chrome has it — the size its
line flexed it to along a row, and stretched across a column as any item
is — where in a block's flow it is as wide as its columns. Across a column,
an item that is not stretched — `items-start`, `items-center`, an
`align-self` of its own — is `fit-content` wide (CSS Flexbox 9.4): as wide
as its content in the room the column has, and no narrower than its content
at its narrowest, so a word or a box wider than the column runs out past
it, past both sides where it is centred, as in Chrome. `min-width: 0`
changes nothing there, an automatic minimum being the main axis's alone.
An image is its natural width, and one with only a ratio, such as an SVG
with only a `viewBox`, the column's. An item with something in it that
takes a percentage of a height is fitted to the column, though: it is
measured before the flex layout makes that height definite, where Chrome
measures it at that height. In a column that wraps, each line is as wide
as its widest item, every item `fit-content` (9.4, steps 7 and 8), and is
placed across the box by this engine, Yoga laying out only what goes down
it: `align-content` centres, ends or spaces the lines out in what the box
has past them, or stretches them to it, its `start` and `end` the box's
left and right sides, and a line wider than the box runs
past both its sides where it is centred, or past its start where it is
ended, starting at its right edge where the lines run right to left.
Lines wider than the box that `space-around` or `space-evenly` would space
out are set at its own start, its left or its right where it runs right to
left, and run past its end (`safe center`, CSS Box Alignment 3, 4.3 and
5.1), whichever way they wrap: in reverse they were set from their own
start, past the box's. A
stretched item is as wide as its line, within its limits, and as tall as
its content makes it at the width it had before it was stretched, as the
specification has it where a column wraps (9.8) and as Chrome does: an
item holding only a box of `width: 100%` and a ratio is none wide before it
is stretched, so none tall, and the box runs out of it. An `auto` margin
takes the room the line has past the item, and `align-self` sets it in its
line. An item that is not stretched and whose width the room decides — an
`auto` one, `fit-content` or `stretch` — is fitted again into its line,
less its margins, where the line is wider than the box: a paragraph after
an item 130 wide in a column of 100 is 130 wide, as tall as the column made
it at 100 (CSS Flexbox 9.4 step 11, as csswg-drafts#11784 has it, and as
Chrome lays it out; Firefox and Safari still fit it to the box). Those
aligned by baselines keep the left edge they share and run past the line's
end. An image keeps its width, and so does an item whose width its ratio
makes of its height. An item, and a grid's,
is a formatting context of its own: the margins of what it holds stay
inside it, and the one under its last block makes it that much taller. An
`auto` margin takes
the free space on its side, so `margin-left: auto` puts an item at the end
of its row. A row of flex items inside another item is as wide as its items
side by side and the gaps between them — an item with a `width` of its own
counting as that width, whatever the row would shrink it to (CSS Flexbox
9.9) — and a percentage `max-width` on a box with a width takes nothing
from what the box gives the size of whatever holds it, being a percentage
of the size that is being worked out (CSS Sizing 3, 5.2.1): a row of
buttons `width: 98px; max-width: 100%` is as wide as its buttons. A gap is
a length, or a percentage
of the container's size along it. A percentage in an item's padding, its
margins or its `min-width` and `max-width` is of the container's content
width, the item's containing block's, whatever width the item was flexed
to: a column set `flex: 1 0 50%; max-width: 50%`, as a Bootstrap or an
Infima grid has it, is half its row. The items are laid out in the
container's content box, its height less the padding and borders a
`border-box` height holds, and a container with no height of its own gives
its `flex: 1` items what its `min-height` leaves them, so a page
`min-h-screen flex flex-col` puts its footer at the bottom of the window. An item is shrunk no smaller than its
content comes to — its min-content width in a row, its content's height in a
column — unless its own minimum or an `overflow` that scrolls lets it go,
as Tailwind's `min-w-0` does; in a column that is the lesser of a height of
its own and its content's, and an item with an `aspect-ratio` counts its
width through the ratio as content, and along a row a definite height
through it. A table is no smaller than it can be whatever its minimum or
its size says: its columns at their narrowest along a row, and its rows
and captions, the spacing round them in, down a column — the item after it
starting where it ends, as in Chrome. An item its minimum stops is frozen at it, and the others on
its line share what is left (CSS Flexbox 9.7): of three `flex: 1` items, one
holding a long word is as wide as the word and the other two halve the
rest, and a line too short for any of its items has each at its least size,
running out of the box — its content's, a `min-width` of its own such as
Tailwind's `min-w-max`, or no more than its padding and borders. On the
lines of a box that wraps, a held item still
takes its share of the line's room on top of its minimum — Yoga's reading,
not the specification's. The one line of a box that does not wrap is shared
out as CSS Flexbox 9.7 has it wherever an item has a minimum or a maximum
of its own, the flex factors come to less than 1, or the line is short of
room and its items' padding and borders would weigh in what each gives
up: each item from its flex base size, going round until no limit stops
one, a minimum over a maximum winning, and factors under 1 sharing out
only that part of the room. So `flex: 1; min-width: 200px` beside a `flex: 1` in a row of 600 is
300 wide, as in Chrome — grown from nothing, where Yoga grew it from its
minimum to 400 — and `width: 100px` three times with minimums of 95, 45
and 0 in a row of 150 is 95, 45 and 10, where Yoga left all three 100 wide.
What a line is short of is shared out by each item's shrink factor times
its content box, where Yoga weighs its border box: two items 100 wide,
one with 50 pixels of padding, are 100 and 50 in a row of 150, as in
Chrome, where Yoga made them 90 and 60. A percentage height,
minimum, maximum or flex basis of an item down a column of a definite
height is of that height; down one of no definite height, a percentage
height is `auto` and a percentage flex basis is `content`, the content's
height whatever height the item has of its own. An item with a ratio is as wide, down a column, as the height
it was flexed to makes it, and an image grown along a row is as tall. A
`flex-basis` holds down a column with no height of its own, where Yoga
would read the item's height in its place. Down a column that wraps, an
item stretched across its line is as tall as the line made it, whatever its
margins, as in Chrome: Yoga lays each such item out again as it stretches
the lines, at its height plus its left and right margins less its top and
bottom ones, so `margin: 0 5px` around a line of text came out 10 pixels
taller than Chrome's. Such an item takes the height Yoga gave it before
that pass. An item stretched across its
row, or flexed along a column of a height of its own, has the height it was
given — no taller for what it holds — for what it holds to take a
percentage of, so an `h-full` list in a sidebar fills the sidebar. An item
that is a flex box or a grid itself lays its own items out in the height it
was given, which is a second layout of it where that is not its content's:
a card in a row of cards has its `margin-top: auto` button at its bottom,
its `flex: 1` takes what the others leave, and what it centres is centred
in the whole of it. That holds along a column with no height of its own
too — `min-h-screen flex flex-col` around a `flex-1 flex items-center` —
though nothing takes a percentage of such a height, as in a browser. In a
row that wraps, each line is as tall as its tallest item at its content's
height, and an item stretched across it as tall as the line (CSS Flexbox
9.4, steps 7 and 8): past the bottom of a row with a `height` its items
outgrow, or past its top where the lines run in reverse, as in Chrome,
where Yoga, which lays the box out, measured a stretched item at the row's
height wherever the row had room along it for every item, and squashed a
taller one to it. `align-content: center` and `flex-end` move such a line
by its own height, past both edges or the far one where it is taller than
the row, and `start` and `end` are the row's top and bottom, which a row
that wraps in reverse has at its lines' ends. `space-between`,
`space-around` and `space-evenly` put the room the lines leave between
them and around them, the latter two centring a row's one line, and an
item stretched across a line spaced out so is as tall as the line, where
Yoga made it taller by the room after the line too. Lines taller than the
row the latter two would space out are set at its top and run past its
bottom, `safe center` setting them at the box's own start, where Yoga set
them at the lines' start: in a row that wraps in reverse, at the bottom,
and they ran past the top. Items go in `order`, and in the document's where two have the
same, and are painted so, each whole, among the lines of the flow around
the box (CSS Flexbox 5.4): over the background of a block after it that a
negative margin draws up under it, and under that block's text. One with a
`z-index` is a stacking context
whether or not it is positioned, a grid's item too. Items aligned by their `baseline` line up their first lines at
their line's start, its bottom in a row that wraps in reverse, their
line as tall as that makes it — an item shorter than its first line, or
whose padding puts the line under it, on that line all the same, and only
one that is a scroll container on its border edge — `last baseline` is taken as the end of the
line, which is what it falls back to — and a flex box sits on the baseline of its
first line's item aligned so, or of its first item. An inline-block whose
last block is a flex box or a grid sits on that baseline too, the one the
box has on a line of its own, and a table in one gives it none, as Blink
and Gecko both have it. Items meet where
they meet, fractions of a pixel included, and the paint snaps their edges.
A multicol container (CSS Multi-column 1) sets its content in columns:
`column-count`, `column-width`, the `columns` shorthand and `column-gap`,
whose `normal` is an em there, and the `-webkit-` names Chrome still reads
for them. There are as many columns as `column-count` says or as
`column-width` fits, the fewer of the two, each as wide as leaves the gaps
between them, and the container is a formatting context of its own. Its
content is laid out once, a column wide, and broken where CSS Fragmentation
3 has it break: between the lines of a block and between boxes, never
inside a line, an image, a table, a flex box or a grid, a box that clips or
one that says `break-inside: avoid` (`page-break-inside` too), with
`orphans` and `widows` lines of a block kept at either side of a break, two
of each unless they say otherwise, and a margin at a break dropped. A box
with a height and nothing in it, a float among them, is cut wherever a
column ends and goes on at the head of the next. The
columns balance, and CSS leaves how to the user agent; this does as Blink
does — the content's height shared out between the columns, no less than
the tallest thing that cannot break, then as much
taller as lets the next line or box into a column, until they hold it all —
so a page breaks where Chrome breaks it. A container with a `height` or a
`max-height` has columns no taller than it, and what they do not hold goes
on in columns past its edge; under `column-fill: auto` its columns are that
tall, each filled before the next is started, and with no height to fill
to the first holds everything. A float that cannot be cut, an image, stays
with the lines beside it, where a browser takes it to the next column and
sets those lines again without it. A child of the container that says
`column-span: all` is set across all its columns: what comes before it is
balanced in columns of its own, the box under them as wide as the
container, and what follows in columns under it; its margins collapse only
with those of a spanner next to it, and the container is no narrower than
it where its content sets its width. A box a break falls inside has a piece in each
column: its background and its borders are drawn a piece at a time, with no
edge at the break, `elementRect` answers the rectangle that takes in all of
them, as a browser's bounding rect does, and a point between two of them is
not over it. Right to left, the first column is the one at the right. A
container as wide as its content is as wide as its columns side by side.
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
the tracks, and `place-content` sets both — so `place-content: center`
centres a page's one column. An item is stretched to its area or aligned in it by
`justify-self`, `align-self` and its `auto` margins, and one that is not
stretched is as wide as its content fits. `normal`, which is what an unset
`align-items` is, stretches an item but an
image, which keeps its own size, and a box with an `aspect-ratio`, which is
as wide as a height it has makes it, and as a block would be where it has
none; `stretch`, the grid's or the item's own, stretches those too, and an
item stretched down its area is as wide as its ratio makes that
height. In a flex box `normal` is `stretch`. A table among the items is stretched across its area too, as Chrome
stretches one, where in a block's flow it is as wide as its columns. An item's area is its containing block: a percentage in its
margins, its padding, its `min-width` or its `max-width` is of the area's
width, whatever width the item comes to in it, so `width: 50%; max-width:
80%` is half its column. While the columns are being sized there is no
area yet, and a percentage in a margin or a padding is of nothing — a
column is as wide as what is in its item, and the margins and the padding
come out of that. A percentage `width` or `max-width` is `auto` and `none`
then, but an image's, which is of nothing: an `auto`, `fr` or
`min-content` column is at least as wide as its item's content, and the item
`width: 100%` is as wide as the column that makes. An item's percentage height is of its area, and a stretched item's
height is one what is in it takes percentages of — and one an item that is
a flex box or a grid lays its own items out in, so a grid of cards, each a
column ending in a `margin-top: auto` button, has every button at the
bottom of its row. A grid is as wide as
its tracks, whatever runs past them. An absolutely positioned box
takes the grid area its lines name for its containing block, and a grid's
or a flex box's child is where it would be as the box's one item.
A grid sits on the baseline of its first item in row-major order — the
first in its first row that holds one, by where it was placed — and an
item with no line of its own gives the bottom edge of its border box (CSS
Grid 1, 10.6): a grid of icons sits on the first icon's bottom edge, and a
grid with no item has no baseline.
Baseline alignment of the items and subgrids are not read.
A table's borders collapse where it asks: one border along each edge of its
grid, centred on it, chosen from the cells, rows, row groups, columns,
column groups and the table that meet there as CSS 2.1 17.6.2.1 chooses —
`hidden` first, then the widest, then the style, then the box. A caption is
outside the table's border, above it or below it by `caption-side`, and an
auto table is at least as wide as its caption's longest word. A header
group's rows are drawn first and a footer group's last, wherever they stand
in the markup, and a cell's background fills its row whatever
`vertical-align` does with its content. An absolute box with no offsets in
the cell goes where that content went, since its static position is where
the flow would have put it and the flow is what moved: a badge over an icon
in a `middle` cell stays on the icon. A height a cell sets is a least one
for its row, beside what its content needs once `vertical-align: baseline`
has moved it down to the row's baseline, and not more room under that move
(CSS 2.1 17.5.3), as in Chrome. That height is of the box the cell's
`box-sizing` names, at least its padding and border where that is the
border box, and the cell's `min-height` and `max-height` count for nothing
in it, as in Chrome; the quirks-mode rule that takes every cell's height as
a border box is not followed, since `<Html>` has no quirks mode. A cell
spanning rows asks its first row for its baseline and the rows for its
content and height alone, as Chrome does, so content the baseline moved
down can hang out of it. A fixed table takes its columns' widths from its
`<col>`s, then from its first row's cells, border box and
all (CSS 2.1 17.5.2.1), and shares its width out as Blink does: the
lengths first, then the percentages in what the lengths leave, scaled down
to it, then the columns set to neither. Percentages that come to more than
100% are scaled until they come to that, and a content-box cell's padding
and borders go on its share, so two cells of 60% in a table of 300 are 147
each and the table stays 300 wide. Where no column is set to neither, what
is left goes to the lengths, or failing those to the percentages. Only the
lengths, and a `<col>`'s `min-width`, widen the table. A cell spanning
columns gives each it spans with no length an even share of its width less
the spacing between them, and each with neither an even share of its
percentage. With `width: auto` it is laid out by its content, as the
section says, where a column's `width` counts as its cells' do
(17.5.2.2). A column group's
`width` is the default of each `<col>` in it that sets none, and each takes
the whole of it, not a share: the width specified for a column is its own,
or else its group's (CSS Tables 3, 3.8.3), as in Chrome, where CSS 2.1
17.5.2.2 spread the group's width over its columns. A group with no `<col>`
stands for each column it spans, and a fixed table takes the group's width
for those and for no `<col>`, as Blink does. A percentage `width`, a
cell's or a column's, is of the table's width less its `border-spacing` in
either layout — CSS Tables 3's assignable table width, the spacing either
side of every column out — as Blink takes it, so a `width: 50%` cell in a
table of 300 spaced 2 is 147. Laid out by its content, a table keeps the
percentage a percentage until its width is known, and the percentages
help decide it: an auto table is wide enough that each column's content
is no more than its percentage of the table, and that the columns with
none are what the percentages leave, as Blink widens it
(`ComputeGridInlineMinMax`) where CSS Tables 3 says only that a percentage
is a constraint to try to satisfy (3.9.2). So a 20% column beside one set
to 100px is a table of 125, where the room allows it, and two 30% columns
over 10px of content one of 33.33. A table measured for what it asks of a
table cell, a flex box or a grid around it, or set `width: max-content`,
asks for its content alone, and laid out in that, shares it; one measured
for a float or an inline block asks for its percentages too, as in Chrome.
An auto table's percentages come to no more than 100%, the columns' in
order, the one that would take them past it having what is left; a
spanning cell's
percentage goes to the columns it spans that have none, in proportion to
their content; and a `<col>` with a percentage takes its group's length
beside it. The table's width — its own, the room it has, or what its
captions or its `min-width` hold it to — is shared out over the columns as
CSS Tables 3 shares it (3.9.3): every column at its least, then the
percentages grown towards theirs, then the columns set to a length towards
it, then the rest towards their widest content; and what is left over goes
to the columns set to nothing, or else to those set to a length, or else
to the percentages, by them. A percentage in a cell's padding is of the
width of its row — the columns and the spacing between them — as browsers
take it, and of nothing while the columns are sized, so a padded cell's
column is as wide as its content asks. A cell's `min-width` and
`max-width` are weighed where the columns are sized, and as lengths (CSS
Tables 3, 3.8.2): a cell asks of its column its content held up to its
`min-width` and down to its `max-width` — its min-content too, as Blink
has it, so `td { max-width: 50px }` over a long word, or over a line that
does not wrap and ends in an ellipsis, makes a column 50 wide — and
neither sets the column's width, which only a `width` does. A length
`max-width` holds a length `width` and not a percentage one, in a fixed
table's first row too, where a `min-width` only raises it. The cell is
then laid out at the width of the columns it spans, whatever its limits
say (3.10.2). A column's or a column group's `min-width` is the least it
is, and its `max-width` does nothing, as in Blink: a column's outer
min-content width is `max(min-width, width)` already. A group's
`min-width` raises the width it gives its `<col>`s and is not the least of
any of them, only of the columns it stands for. A percentage
`min-width` is ignored, and a percentage `max-width` holds a percentage
`width` and nothing else. A column's or a column group's background is
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
the empty ones. That is so of a height of its own and of one a flex box or
a grid gives it, stretched down its line or its area or flexed down a
column: the rows grow to the height, less its captions, and a cell's
`vertical-align` has the row to move its content in. A height a flex box
gives it stands in for its own, which the flex layout started from, so a
table flexed down a column shorter than its `height` is as short as that.
A table is never shorter than its rows, though, whatever height it is
given or its line or its area has.
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
whole. A line's inline-blocks and images are painted in their turn among
its text, and one line before the next (CSS 2.1 Appendix E, 7.2.1), as
browsers paint them: an inline-block a negative margin draws the text
after it over is under that text, with its decorations and its shadow,
and under the background of an element that starts after it, on its
line and on any line it hangs into, and over the text before it. On a right-to-left line Chrome
and Safari paint them left to right instead, and Firefox as here. A
block is painted in parts only where one of them covers what comes after
it.
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
rounded down, and a hairline one), `box-sizing` (a `border-box` size or
limit under the padding and borders leaves the content box none wide, so
the box is as big as them, as in Chrome), `overflow`, `clip`,
`opacity` — an element under 1 is a stacking context, painted whole, the
positioned boxes in it with it, among the positioned boxes (see
`z-index`), at 0 not at all and between
faded as the group it is (CSS Color 4, 3.2): on X11 and Wayland, where two
things it draws can overlap — a background under its text, a badge over a
header — it is painted on a surface of its own and the surface faded, so
neither shows through the other, and where it draws one thing, a
background alone, that thing is faded. Text is a group there too: ntk
draws a text layout's glyphs in their runs' colours whatever alpha the
context holds, and a paragraph at `opacity: .5` drew at full strength. On
macOS it is a group too where react-x11 says a surface drawn faded costs
about what it costs opaque (`fadesSurfacesCheaply`, over an
@windowkit/appkit that scales the surface's pixels by the alpha). On
Windows, and on macOS before that, each thing drawn is faded on its own,
so where two of its boxes overlap the lower shows through: CoreGraphics
drew a surface under an alpha at more
cost than drawing again what was on it. A box fixed to the viewport inside
one fades each thing too. An inline element under 1 fades what it holds:
its text, with the decorations, shadows and selection drawn with it, its
background, borders and outline, the inline-blocks and images on its
lines, and a block inside it. All but the block are drawn on its block's
lines, where a paragraph's text is one batch of glyphs that no context
fades a part of, so each is faded on its own, the text in the colours it
is set in, and its background shows through its text where a browser's
group would not let it. The floats and positioned boxes in it are faded as
an element's are, and a hover or an animation that changes its opacity
sets its text again in the new colours where it is, as a change of colour
does — `isolation` — `isolate` makes a box a stacking context, positioned
or not, painted whole among the positioned boxes as one under full
opacity is, so a box in it with a negative `z-index` goes over its
background and under its text (CSS Compositing 1, 3.2) — `visibility` — a
hidden element keeps its room and draws nothing, its text included, and a
visible element inside it is drawn; a
collapsed table row or column gives its room and its spacing back —
`z-index`: a positioned box with a negative
`z-index` is painted under the flow of its stacking context, the root
element or a positioned box with a `z-index` of its own, and over that
context's background (CSS 2.1 Appendix E). A box that is a stacking
context without being positioned — under full opacity, transformed,
masked, cut by a `clip-path`, with layout or paint containment or
`isolation: isolate`; a float
or a flex item as much as a block — is painted with the positioned boxes
whose `z-index` is 0, in the document's order among them (Appendix E,
step 8), as Chrome, Firefox and Safari paint it: over the text of a block
after it that a negative margin draws up under it, and over a relative
box before it. An inline-block or an image is one as much as a block is,
and so is one that is positioned: painted with the positioned boxes, over
the text after it on its line and on the lines after that. An
absolute box with both offsets on an axis fills what they leave, or, with
a width, shares it between its `auto` margins, which is how `margin: auto`
centres one. A form
control fills it too, as it does in Chrome — it is an inline block to CSS,
whatever draws it — so the invisible `<select>` a page lays over a picker
it draws, `position: absolute; inset: 0`, covers all of it and takes the
press anywhere on it; an image keeps its own size (CSS 2.1 10.3.8), and a
table is as wide as its columns and as tall as its rows, which its `auto`
margins place, as Chrome has it. An absolute box with no offsets that
was inline-level before it was positioned — a `<span>`, or a `<div>` the
page made `display: inline` — and stands among blocks is where it would
have been on a line of its own: beside the floats there, at the point
`text-align` puts it, its right edge there in a right-to-left block. A
box is painted with each edge on the pixel it falls nearest, as browsers snap
one, so a rule `1pt` wide is a pixel and boxes that meet at a fraction of a
pixel share the column between them. A corner's radius is a length or a
percentage — of the box's width across and its height down, so `50%` is a
circle on a square box and an ellipse on any other — and a `/` gives the
corners vertical radii of their own; radii too large for their box are
reduced together, so `calc(infinity * 1px)`, Tailwind 4's `rounded-full`,
is a pill. A rounded box's border is a ring rounded on both its edges, the
inside by each radius less the border across it, where every side that has
one has a solid rule: a card's, a button's, and an accent down one side,
which curves into the corners it meets. Where its sides are of different
colours each has its share of the ring, the colour changing on the curve of
a corner on the line from the corner of the border box through the corner
of the padding box, as Chrome changes it (CSS Backgrounds 3, 4.4) — so the
spinner, `border-radius: 50%` with one side of another colour, is a ring
with a quarter of it in that colour. A side with no width gives the whole
of its corners to the sides beside it, and an opaque share is drawn over a
little of the one next to it, so the page does not show through where the
two meet. A dotted, dashed or double side on a rounded box has its border
drawn straight. Two solid
sides of different colours share their corner on its diagonal, from its
outer point to its inner one (CSS Backgrounds 3, 4.4), so each is a
trapezoid — and a triangle on a box with nothing inside its borders, which
is the CSS triangle: one coloured border between transparent ones, the
caret of a dropdown and the arrow of a tooltip, and the slanted edge of a
section, `border-left: 100vw solid transparent`. Sides of one colour are
rectangles, the top and the bottom full width, and so are a dotted, a
dashed and a double side next to any other, and a corner one device pixel
square. A double side is two lines a third of its width each, along its
outer and its inner edge (CSS Backgrounds 3, 4.2), and where it meets a
double side of its colour the lines of the two join, so a double border
of one colour is two frames: the outer along the border edge and the
inner along the padding edge, as Chrome draws it. `groove`,
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
captions outside the clip. A box that clips is no stacking context, and
is painted in the passes of the flow around it as a block is (CSS 2.1
Appendix E), as Chrome, Firefox and Safari paint it. Its own background
goes with the other blocks' backgrounds. What it holds goes in the same
passes under its clip: the backgrounds of the blocks in it with the
backgrounds, its floats with the floats, and its lines and its outside
marker with the lines. So a block after it that a negative margin draws
up over it covers its background and the backgrounds in it, and a float
after it covers a block in it. A table is painted the same way, whether
it clips or not. Its background, its parts', its cells' and their borders
go with the blocks' backgrounds, and its collapsed borders over them;
what its cells hold goes in the later passes, so a cell's text is drawn
over a collapsed border. A flex box or a grid that clips is painted
likewise, its background with the backgrounds and its items, each whole,
with the lines under its clip. `clip` shows the part of an absolutely positioned
box it names, and of what the box holds, and nothing it cuts away is under
the pointer (CSS 2.1 11.1.2): a label hidden for a screen reader alone with
`clip: rect(0, 0, 0, 0)` takes no hover and no press from the link it lies
over. One thing is let out of it, a `position: fixed` box in a clipped box
that is no stacking context — one with no `z-index`, not itself fixed —
which is drawn whole and found where it is drawn; a browser cuts that one
too. `clip-path` shows the part of any box its shape names, and
of everything in the box — one positioned from outside it too, which a box
that clips its overflow lets out — and nothing it cuts away is under the
pointer (CSS Masking 1, 5.1). The shapes are the rectangles of CSS Shapes:
`inset()`, `rect()` and `xywh()`, with the corners `round` gives them, in
the box the value names, the border box unless it says; or that box alone,
rounded as the element is. Insets that meet or pass each other leave
nothing, which is how Tailwind 4's `.sr-only` hides a label with
`inset(50%)`. An edge is on the pixel it falls nearest, where a browser
antialiases it. And `polygon()`, its vertices lengths or percentages of
the box's width and height, inside by its fill rule — the way bun.sh cuts
a corner off every button — where they fall in the box, itself on the
pixels its background is drawn on, so a slanted edge is antialiased as a
browser draws it and one along the box's edge is not; one whose vertices
are all on a line leaves nothing. The `evenodd` rule is the X11 and Wayland contexts';
macOS and Windows clip by `nonzero`, which only a polygon that crosses
itself can tell apart. `round`, which Chrome alone reads in a polygon, is
not read, as Firefox and Safari read none. The element is a stacking
context, painted whole among the positioned boxes as one under full
opacity is, and its scrollable overflow is what it was, as a browser has
it: a box hidden by a
path alone still makes the page as long as it reaches. `circle()`,
`ellipse()`, `path()`, `shape()` and a `url()` naming an SVG `<clipPath>`
are read and cut nothing, and an inline box that is not atomic is not
cut. Inline elements
have all of it but the
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
not stretched across a column, and a row item not shrunk below it. A
minimum of one wins over a smaller `max-width`, as a length does: a flex
or grid item `min-width: max-content; max-width: 20px` is as wide as its
content. And
`fit-content()` of a length or a percentage, which fits the content in the
room its argument makes: no wider than the content at its widest, nor
narrower than its longest word. The sizes are the content's, whatever
`width` the box has beside them, with the box's padding and border round
them, a percentage of either of its containing block's width. A height of one is its content's, which
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

**Transforms:** `transform` and the three properties that are one function
of it each, `translate`, `rotate` and `scale` (CSS Transforms 1 and 2), in
the plane of the page, about `transform-origin`. A transform is no part of
layout: the box is laid out as though it had none, moved by the translation
its transform comes to — `translate(-50%, -50%)`, Tailwind's
`-translate-x-1/2` in either of the ways it is written, a percentage being
of the box's own size, so the absolute box it centres is centred — and
painted through the rest of it, a turn, a scale or a skew: the triangle a
menu button turns with `rotate(90deg)` to point down, an accordion's
chevron at `rotate(180deg)`, a card a hover grows with `scale(1.05)`. What
the box holds is painted with it. The pointer finds it where it is drawn, a
selection is made and painted there, and `elementRect` answers the
rectangle around where it is drawn, as `getBoundingClientRect` does; so is
what it draws counted in the document's scrollable overflow. A transformed
box is a containing block for the absolute and fixed boxes inside it and a
stacking context, painted with the positioned boxes in the document's
order, whatever `z-index` it has where it is not positioned, as in a
browser. A box whose transform flattens it to nothing — `scale(0)` — is not
drawn, is not under the pointer, and mounts no form control. A transform on
an inline box that is not an atomic one does nothing, as CSS has it.

What is drawn through a matrix is as good as the context is at it. The
native contexts on macOS and Windows draw everything through one, a text
layout's outlines among it, glyphs and all. X11's draws paths through one;
a glyph it draws as it was shaped, where the matrix puts it, and an image
through a transform the server keeps in fixed point. So there only a box
that is paths and flat colour — an icon, a chevron, a spinner's ring — is
drawn through the matrix, and one that holds text, an image, a gradient or
a shadow is painted on a surface of its own, as it was laid out, and the
surface drawn through the matrix: exact at a quarter turn or a reflection,
and resampled — soft — where it is scaled up or turned by another angle.
The surface is drawn at the box's opacity, so such a box is faded as the
group it is, and it is kept from one paint to the next while an animation
turns or fades the box, or while the surface is small (see Animations).
Such a box scaled so small that the server's fixed point cannot carry it —
to a thirtieth of its size far across a wide window, or flatter than can be
seen — is not drawn there. On every backend a box's corner is snapped to
the pixel it is drawn from before its transform, as a browser snaps it, so
a quarter turn of a box a fraction of a pixel down the page stays on the
grid. A box drawn through its matrix casts its shadows through it too, and
its text its text shadows: turned, scaled and offset with the box, their
blur scaled as it is, as a browser casts them as part of the box.

What is out of the plane is read and not drawn: `rotateX()`, `rotateY()`,
`translateZ()`, `perspective()` and the depth of a `matrix3d()` or a
`scale3d()` are left out of their list, whose other functions are drawn, so
`translateZ(0)` and `translate3d(x, y, 0)` are the transforms they are in
the plane. `perspective`, `transform-style`, `backface-visibility` and
`transform-box` do nothing, and a card that flips shows both of its faces.
A form control in a turned or scaled box is mounted where the box was laid
out, as it is: a widget is a node of its own, which no matrix of the
document's reaches. `background-attachment: fixed` in a transformed box is
still fixed, where CSS has it scroll.

**Animations:** `@keyframes`, and `@-webkit-keyframes`, which never takes
the place of an `@keyframes` of the same name, as in Chrome; `animation`
and its eight longhands, under their `-webkit-` names too. They run on the
document's timeline. An element's animation starts when its style first
names it, and keeps its time for as long as its style goes on naming it —
through a hover, a stylesheet arriving, a document built again — and one
the style stops naming is over, and named again starts again. Its delay,
iteration count, direction and fill are as Web Animations has them, and a
paused one holds its time until it plays again. At each frame the values
between the two frames around its progress are interpolated as computed
values: a number, a length — a percentage at one end and pixels at the
other mix — a colour, in premultiplied sRGB, a `visibility`, visible all
the way between a visible end and another, and `transform` lists, function
by function where their functions are alike, so `rotate(0)` to
`rotate(360deg)` turns once, and as matrices taken apart into a
translation, a turn, a scale and a skew where they are not. What none of
that reads goes over half-way, as CSS has a discrete value go; so does a
shorthand any of whose longhands does, a custom property and a logical
one. A frame's `animation-timing-function` eases to the next frame, and
the animation's own where it gives none. The values sit at the animation
origin, over the author's normal declarations and under their
`!important` ones (CSS Cascade 5, 6.1). A `::before`'s and an `::after`'s
animations run; a marker's, a first letter's and a first line's are drawn
at rest, as below.

A frame restyles the elements an animation is under way on, and what they
hold where it animates an inherited property. Where all it changes is
what a hover may change in place — a colour, an opacity, a visibility, a
transform, a `z-index` — it repaints their ink and nothing else. Anything
else, a length that moves something, builds the boxes again around every
other element's kept style and lays the document out; where each element
that changed is positioned absolutely or fixed, or inside one that is, as
a marquee or a slideshow's panel is, nothing around it moved, and only
what those boxes drew before and draw now is repainted. Nothing ticks while
nothing changes: a frame is asked for while an animation is under way, at
the end of a delay, and not at all once each is over or paused.

`animate={false}` runs none, and a document is drawn as it stands once
each of its animations has run one iteration at no length. One that fills
forwards then holds the frame it ends on — its `to`, or its `from` where it
plays in reverse — and any other leaves the element's own style. So a page
that fades its panels in and holds them shows them, and one that cycles
hidden panels through `visibility` shows none — what Chrome draws with
every animation set to no length, which is how the Zen Garden bench holds
Chrome, and how it runs `<Html>`. The iteration count, the duration and the delay are
not used there, so an animation of two `alternate` iterations, or of half
of one, is drawn as it ends its first. Transitions are not run either way.

Every frame runs in JavaScript, on either backend. Where a box is drawn on
a surface of its own — on X11 one that turns and holds text, an image, a
gradient or a shadow, and on X11 and Wayland an element faded as a group
— and an animation turns, scales, skews or fades it, the surface is kept
while the animation runs: the box and what it holds are painted on it
once, and a frame draws it through the matrix and at the opacity the
frame has, so a fade paints nothing but that. A surface no larger than a
card's is kept while nothing animates it too, and a repaint draws it as
it was. Whatever else changes what is on it paints it again: a hover
inside it, a colour animating in it or with its turn, a box in it that
turns on its own, a selection across its text, a translation that moves
it by a fraction of a pixel, a resize. One kept for an animation is given
up when the animation is over. The native contexts on macOS and Windows
draw a turned box through the matrix every frame, as they draw any box. A
faded element's group, and a fade's kept one, are macOS's where its
context says a faded surface is cheap, and on Windows each thing it draws
is faded every frame. What the platforms could run of the rest, Core
Animation among them, is [a design document](../prd-html-animations.md).

**On macOS an animation a layer can carry runs in the render server.**
react-x11's surface presenter asks a drawn element for the parts of its
drawing it may lift onto layers of their own (react-x11's `sprites()`,
sidorares/react-x11#819, with `@windowkit/appkit` 0.19), and the document
offers each element whose animation is one a browser would hand its
compositor:

- its one animation sets only `opacity`, `transform`, `translate`,
  `rotate` and `scale`, plays, and is past its delay;
- it is a box of its own — not an inline split across lines, not a
  `::before` or an `::after` — and is not fixed, clipped, masked or drawn
  against the viewport;
- nothing it is inside fades, turns, clips, masks, is fixed, or runs an
  animation of its own;
- and no ink in the document but its own and its ancestors' — which have
  no outline — falls anywhere it can be while it runs, whether painted
  before it or after.

The last is deliberately strict: a toast, a panel fading in, a spinner and a
card turning on its own pass it, and a badge over a card it does not belong
to is left to the document. The frames go over as the document runs them:
the element's style is sampled through a cycle of its animation — two
iterations where it alternates — at a display's rate, so every easing,
`steps()` among them, a frame made of the element's own value, a whole turn
and a mixed transform list come out as `<Html>` draws them, and the render
server plays straight lines between. At rest the layer shows what the
animation leaves: the frame it ends on where it fills forwards, the
element's own style where it does not.

A lifted element is a hole in the document's paint, and its animation is
no frame of the document's: a fading panel and a turning card cost no frame
and no paint between them where the clock painted each sixty times a second.
The presenter decides again every frame, and an element it gives back —
something now drawn over it, a scroll that takes it under a clip — is
restyled at once to where its animation has got to, drawn, and run on the
document's clock from there. One the render server runs to its end is given
back to be drawn as it ended. While an element is lifted its style is the
one it had when it was lifted, so a pointer is hit against where a moving
element was then, not where it is. Everywhere else — X11, Wayland, Windows,
a core or a bridge that predates the seam — nothing asks, and every
animation runs on the document's clock as above.

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
or, written `auto 16 / 9`, only where it has none — then of its content
box, as its own ratio is, and of the box `box-sizing` names otherwise. The
ratio runs the other
way too: a box with a height and an `auto` width, or one of its content's,
is as wide as the height makes it, and a least or greatest height is a
least or greatest width through it.

**SVG:** an inline `<svg>`, an SVG image and an SVG background are drawn by
ntk's `SvgView`, which core's own `<svg>` element draws with, so they draw
its subset: shapes and paths, groups, `<use>`, gradients and plain text,
with presentation attributes and `style` attributes — not filters, masks
or clip paths. An inline `<svg>`'s `fill` and `stroke` are the document's:
properties a style sheet's rule sets on the element over its attributes,
which inherit into it, and from it to the shapes it draws. That is how an
icon set paints its icons, `.icon { fill: currentColor }`. A rule may name
an element inside the drawing as well — `.logo path { fill: #fff }`,
`a:hover svg path { fill: red }` — and sets its `fill`, `stroke`,
`stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`,
`fill-rule`, `fill-opacity`, `stroke-opacity`, `opacity`, `color`,
`display` and `visibility`, and a gradient stop's `stop-color` and
`stop-opacity`: over the element's presentation attributes and under its
`style` attribute, as the cascade orders them, `!important` and `var()`
included. A `<style>` inside the `<svg>` is one of the document's style
sheets, which is where a drawing exported from an editor keeps its colours
— `.st0 { fill: #fff }` for `<path class="st0">`. Those properties are the
ones read, on the `<svg>` itself too (`.icon { stroke-width: 1.5 }`), and
no others: a rule's `transform`, font or dash pattern is not. What is in
a drawing has no box, so the pointer is over the drawing and never over a
shape: `a:hover svg path` follows it, and `path:hover` matches nothing.

An SVG _image_ — an `<img>`'s, a background's, a list marker's, a
`content` image's — is a document of its own, and its `<style>` elements
are its style sheets, and the only ones. They give its elements those
properties as the document's give an inline drawing's, and its root its
`fill`, `stroke` and `color` as well, since it has no box to have them
from; `:root` there is its `<svg>`. No rule of the page's reaches into it,
and neither does the page's `color`, so its `currentColor` is its own —
black, unless its sheets say otherwise. A sheet in a CDATA section is read,
one with a `media` query is under it, and one whose `type` is not
`text/css` is none, as a browser has them. `prefers-color-scheme` inside
an image answers the colour scheme of the element that embeds it — its
`color-scheme`, or else the palette's — as Chrome answers it, and a width
query or a `vw` in one is of the rectangle it is drawn in. The element its
URL names by a fragment is its `:target`: `sprite.svg#check` shows the
icon a sheet hides the others of with `g:not(:target) { display: none }`.

What a `<use>` draws is a copy in a tree of its own, as SVG 2 has it and
Chrome draws it. A rule is matched against the element the `<use>` names
with nothing above that element and nothing beside it, so for an icon from
a sprite `symbol .line` and `#icon .line` reach its line, and
`.sprite .line`, `svg .line`, `use .line` and `a:hover .line` do not. What
the copy inherits is the `<use>`'s: its `fill` and `stroke`, the `color` a
`currentColor` is, its custom properties — and so what a hover changes of
it, `a:hover use { fill: red }` or a link's `color`. A copy of one of the
drawing's own elements is styled the same way, and so may be drawn
otherwise than the element where it stands. A symbol a rule gives
`display: none` is still found by a `<use>`, which draws nothing of it, as
Chrome has it.

An SVG root's `width` and `height` are CSS lengths, a percentage one too;
its intrinsic size is what of them is absolute, and its ratio comes from
them or from its `viewBox`, which is fitted to its box as
`preserveAspectRatio` says. An SVG image with no `viewBox` is laid out at
its own size and stretched to its box, along each axis it has a size on,
as a raster image is and as Chrome draws one. A percentage in
its geometry is of its viewport, and `currentColor` is the `color` the
element inherits. An inline drawing's `<use>` refers to an element anywhere
in the document, so an icon drawn from a sprite — a `<symbol>` in a hidden
`<svg>` at the top of the page — is drawn, in the colour of where it is
used; a symbol's `viewBox` is fitted to the viewport the `<use>` gives it,
its `width` and `height`, or all of the drawing, and what is in it
inherits the symbol's own paint, `<symbol fill="…">`. The sprite may come
after the icons, at the end of the body, and in a document that is still
arriving (`partial`) an icon is drawn again as more of its symbol arrives,
as a drawing is as more of itself does. What the element itself
refers to from outside its symbol, a gradient by `url()`, is not followed,
and nothing is fetched for a `<use>` of another document's. An SVG image's
root `background-color`, in its `style`, covers the whole image, as a
browser paints it over the canvas. XHTML's `<svg:svg>`, under a prefix
declared for the SVG namespace, is the same element. A drawing `SvgView`
cannot read — a colour it does not know, such as a `var()` in a
presentation attribute or a root's own `color: currentColor` — is left
undrawn, an empty box, and the rest of the document is drawn.

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
text engines do natively; an elliptical gradient fills it as a picture of
itself, drawn once. The text is the element's and its descendants' in flow
and floating, a heading's inside a `<div>`, an inline-block's or a flex
item's, and not an absolutely positioned descendant's, as CSS Backgrounds
4 has it. `background-clip: border-area` (CSS Backgrounds 4)
paints a layer where the border paints: its widths and styles and not its
colour, so a transparent border shows the layer through a double border's
two lines, a dotted one's dots or a rounded one's ring, the shapes the
border itself is drawn with. With `text` it paints in both. A `linear-gradient()` is drawn over the colour as
an image the size of the padding box, or the size `background-size` gives
it, repeated like one: by angle, side or corner, with its stops where they
say or spread between their neighbours, and a colour interpolation method,
`in oklab` as Tailwind 4 writes it, read and not honoured; the gradient is
mixed in sRGB. A `radial-gradient()` is drawn the same way (CSS Images 3,
3.2): a circle or an ellipse, to the nearest or the furthest side or
corner of its box or of the radii it names, centred where `at` puts it,
its stops along the ray from the centre to its edge and past it, and
wherever a linear one is: a layer, a mask, a border image. One with no
width or no height is its last colour, as Chrome draws it, and one whose
circle or centre is further off than a context carries is drawn as the
part of it the box sees. **Radial
gradients are drawn on X11 and Wayland**, whose contexts have them;
react-x11's macOS and Windows contexts paint one flat, in a single colour,
so there it is drawn as nothing, over the colour. Conic and repeating
gradients, and the prefixed spellings of all of them, are drawn as nothing
everywhere. The root's background covers the whole canvas, as CSS 2.1
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
SVG drawing or a gradient: the image cut into nine by its
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
edge. An inline box's is drawn round each of its fragments; `invert` is
drawn in the text's colour. `auto` is the platform's own ring (CSS UI 4,
5.3), which is the palette's here: its `focusRing` colour where the
outline's is the text's, its `focusRingWidth` whatever width was given,
and its `focusRingOffset` outside the `outline-offset` — drawn solid, as
the window's own widgets draw theirs. `-webkit-focus-ring-color` is the
palette's ring colour, so normalize.css's `outline: 5px auto
-webkit-focus-ring-color` is read rather than dropped.

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
a browser cuts it — which is how the line is drawn, and no part of how wide
it is: a table cell or a flex item holding the block is sized by the whole
line, so a button whose label is a `truncate` span is cut only where
something lets it shrink, as `min-w-0` does), `overflow-wrap` (a word too long for
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
and `text-underline-offset`. Left at `auto`, an underline is a tenth of the
font size thick and half of that under the baseline, a pixel each at the
least — the font size of the element that set it, so one line runs through
whatever is inside (CSS Text Decoration 4, 2.4 and 2.9; neither text engine
reports a face's own underline, so `from-font` is `auto`). A line through is
as thick, by the same element's font size, and in the same five styles; its
middle is a third of the ascent above the baseline — the ascent of the text
it crosses, a font size at a time, so text of another size inside it is
crossed out through its own middle, where an underline is one line (2.5 has
a line through worked out again at each font size, from the metrics of the
fonts that size is set in, and 2.9 asks one position only of underlines and
overlines). A dotted rule over three pixels thick is round dots spread from
one end of it to the other, and squares under that; a dashed one's dashes
are three times its thickness long and two apart, twice and one from three
pixels thick, the first at its start and the last at its end; and the two
lines of a double one are a pixel apart. `unicode-bidi` is carried out as
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
room, which is how a row of inline-blocks is set without gaps. The space
that is left is the first of them, in the element it was written in: a
link whose text ends in a space, before more on its line, is that space
wider (`elementRect`, a selection's band) and is underlined under it, and
a space a line ends on is removed, from the link and from every box that
ends there with it.

**Generated content:** `::before` and `::after`, and CSS 2's `:before` and
`:after`, as boxes of their own `display` holding what `content` comes to:
strings with their escapes, images, `attr()`, `counter()` and `counters()` in
any counter style, and `open-quote`/`close-quote` over `quotes`, whose
initial `auto` is the marks of the element's language, from its `lang` or
the page's `content-language`, as CLDR has them and Chrome sets them: a
`<q>` in a French page is «un ‹deux› trois» in Switzerland and «un «deux»
trois» in France, and English's marks are for any language with none of
its own. An image is asked for through `onResource`, as a background image is, and is
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

**Selection:** `::selection` sets the band under selected text and the
colour the text is drawn in (CSS Pseudo 4). Both pass down the chain of
highlights, not the elements, as Chrome has them: a `<span>` in a
`div::selection { background: red }` is selected in red, and a `<p>` whose
own rule sets only a colour keeps the red under it. A rule that sets one of
the two leaves the other at none, so `::selection { color: blue }` draws no
band, and text no rule reaches is drawn in `selectionColor`. Selected text
keeps its own decorations and shadows. A selection over glyphs taller than
their line covers them, and one over a tall line fills it.

**Lengths:** `px`, `em`, `rem`, `ex`, `ch`, `lh`, `rlh`, `vw`, `vh`,
`vi`, `vb`, `vmin`, `vmax` — and the small, large and dynamic viewports'
`svh`, `lvw`, `dvmin` and the rest, which on a desktop are the one
viewport — and the absolute units, and `calc()`, `min()`, `max()` and
`clamp()` over them (CSS Values 4). An `ex` is the font's x-height and a
`ch` the advance of its "0", as the text engine reports them, or half an em
where it cannot say; an `lh` is the element's line height, `normal` as its
font's own, and an `rlh` the root's. A `rem` is the root element's font
size, so `html { font-size: 62.5% }` makes it ten pixels, and in the root's
own `font-size` the initial size, as CSS has both. A math function comes down to pixels and a percentage, which
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

**Colours:** the named colours, hex with three, four, six or eight digits,
the system colours, and CSS Color 4's functions: `rgb()` and `hsl()` in
either the comma or the space form, `hwb()`, `lab()`, `lch()`, `oklab()`,
`oklch()`, and `color()` in its predefined spaces. They are read here and
handed to the drawing context as `#rrggbb` or `rgba()`, which both backends
read alike, and one outside sRGB is clipped into it. `color-mix()` mixes in
any of the spaces above but the wide-gamut RGB ones, premultiplied, so a
colour mixed with `transparent` keeps its hue: Tailwind 4's
`bg-blue-500/50` is written that way. A relative colour (CSS Color 5) takes
another colour into any of the functions above and reads its channels by
name, each one kept, swapped, set or worked out with `calc()`: `oklch(from
var(--brand) calc(l + 0.1) c h / 50%)`. The names are numbers in the
function's own range (`r` up to 255, `s` and `l` up to 100, a hue in
degrees), and an alpha left out is the origin's. A mix or a relative colour
with `currentColor` in it is worked out where the colour is used. A channel
of any colour function may be a `calc()`. A system colour (CSS Color 4) is
the palette's where the element's colour scheme is the palette's — `Canvas`
its ground, `CanvasText` its text, `LinkText` and `AccentColor` its accent,
`ButtonFace`, `ButtonText` and `ButtonBorder` its controls', `GrayText` its
muted text — since the palette is this renderer's platform, and Chrome's in
the other scheme, in an SVG image and for the ones the palette has none of.
The deprecated ones are the colours they are the same as. `light-dark()`
takes its first colour where the element's colour scheme is light and its
second where it is dark (CSS Color 5), in any value a colour stands in, a
custom property's included. The scheme is the element's `color-scheme`
resolved against the react-x11 palette's in force, which stands for the
reader's preference: `light dark` follows the palette, `light` or `only
dark` holds whatever it is, and `normal` — the initial value — is the
palette's own, since the palette is this renderer's default look. A page's
`<meta name="color-scheme">` is its root element's `color-scheme` where no
rule sets one, as HTML has it. Where the root element's scheme is the
palette's, the document is drawn on the window's own ground in the
palette's colours, as an unstyled one always is. Where it is the other — a
page that is `color-scheme: light` under a dark palette, as a Docusaurus
site is until its script runs — its canvas is opaque, in that scheme's
`Canvas` colour, which is what CSS Color Adjust gives an embedded document
whose scheme is not its embedder's; and the text and the links the page
does not colour are a browser's for that scheme, black on white with
`#0000ee` links or white on `#121212` with `#9e9eff`. So a page that sets
dark text on no background is read on white, whatever the window is. The
rest of what the palette gives stays the palette's: the UA sheet's borders
and rules, and the widgets a form control is.

**Selectors:** everything [css-select] supports — combinators, attribute
operators, `:nth-child(an+b)`, `:not()` — plus `:hover`, which is answered
from this renderer's own pointer state. `:focus`, `:focus-visible` and
`:focus-within` are answered from what holds the focus: no element of the
document takes it itself — a control's widget does, beside it, and a text
field's says so (see [Forms](#forms)), and a link, a button or a summary
has a box that takes it for it (see [Focus and the
keyboard](#focus-and-the-keyboard)) — so Wikipedia's skip link, hidden with
`:not(:focus)`, shows when Tab reaches it. `:target` is the
element an SVG image's URL names by its fragment, and none in a document.
Specificity is Selectors 4's: `:where()` counts nothing, `:is()`, `:not()`
and `:has()` count the most specific selector in their list, and
`:nth-child(2n of .a)` a class and the most specific in its list, so a
library's `.prose :where(p)` is a class and gives way to a page's
`.intro p`. Escapes are read wherever they stand,
so a Tailwind class such as `md:flex`, written `.md\:flex`, matches. A group
with a selector in it that is not one — an unknown pseudo-class, a name that
starts with a digit — is dropped whole, as CSS 2.1 drops it. Rules nest
(CSS Nesting 1): a rule inside a rule's block is relative to it, `&`
standing for it and a selector without one a descendant, and an `@media`,
`@supports` or `@layer` inside one holds for the same element, which is how
Tailwind 4 writes its `hover:` and `md:` variants. `@media` width, height
and `prefers-color-scheme` queries are evaluated, widths and heights in
Media Queries 4's ranges, `(width >= 48rem)`, as well as `min-width` and
`min-height`, a `calc()` in a value too — the height is the viewport's, and
a document that asks it is styled again when it moves, as one with a `vh`
is. `device-width` and `device-height` are the viewport's too: they are the
size of the screen a page is shown on, which a browser may answer with its
viewport's, and a document drawn into an element has no screen of its own,
so a phone sheet under `(max-device-width: 700px)` applies where the
element is that narrow and not otherwise. The scheme is the react-x11
palette's in force, so a `<ThemeProvider colorScheme>` above the element
answers it and a desktop that switches schemes re-cascades the document.
The orientation and the aspect ratio are the viewport's too, and follow it;
the resolution is the display's scale, so a page's high-DPI rules hold on a
retina panel and not at one dot to the pixel; the rest are a desktop
screen's with a mouse — `hover` and a `fine` pointer, eight bits of colour,
no contrast or colour preference forced, and no scripting, since nothing
here runs one. A feature nothing knows is false, as Media Queries 4 has
it, and so is a query on a size that is no length.
`@import` goes through the resource seam, its media queries kept as the
conditions of what it imports. Cascade layers are read (CSS
Cascade 5): `@layer a, b;` fixes their order, the document's across all of
its sheets, and a rule in a later layer wins over one in an earlier layer
whatever their specificity, a rule in no layer over both, and the other way
round for `!important`. Tailwind 4 writes all of its CSS in four of them.

**Not implemented:** the parts of CSS grid above, transforms out of the
plane of the page, transitions, a multicol container's `column-rule`,
`column-span` on a box further in than its children, forced breaks, and
a table in one broken
between its rows — it goes to the next column whole, and a box a break
falls inside casts no shadow — conic and repeating
gradients, a sticky box that follows the viewport as it scrolls, and the font
properties of `::first-line`. A `<col>`'s or a `<colgroup>`'s borders are
drawn only where the table's collapse. A percentage `height` resolves where
the containing block's height is set, and on an absolutely positioned box.
The initial containing block is the viewport: the box that scrolls the
element, where one does — a browser's page area, under its tabs and its
toolbar — and the window where nothing does, since the element sizes to its
content. So `html, body { height: 100% }` is a viewport tall and `bottom: 0`
with nothing positioned around it is the viewport's bottom, as in a browser
— and in a page that writes a `<body>` and no `<html>`, as most begin
`<!DOCTYPE html><title>`, where the root element is the `<html>` HTML
implies around the body and its percentage height is of the viewport as a
written one's is. The document is as tall as what overflows its root, so
nothing longer than the viewport is cut off — an inline element's padding and border below its
line among it, as a browser counts them, where nothing clips them. The
root's `overflow` is the viewport's, and so is the `<body>`'s where the
root's is `visible`, and the element it came from is `visible` itself
(CSS Overflow 3, 3.3): `html { height: 100%; overflow-y: scroll }` is a
viewport tall and holds nothing in, and `body { overflow: hidden }` cuts
nothing off and is no formatting context, so its first child's margin
collapses through it. A body under a root that gave the viewport its own,
or with containment on either, keeps its `overflow` and clips. What the
viewport does with the value is the host's: the element is as tall as
its content whatever it says, and a `hidden` there does not stop the box
around it scrolling. A document that reads the viewport's height — a
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
every keyboard convention the platform already has. A widget is keyed by
its element rather than by where it is, so a field that layout moves — a
stylesheet or an image arriving above it while someone types — is the same
widget, and keeps its focus, its caret and its undo.

**A control's text is the theme's font, whatever the page's is.** Chrome
sets `<input>`, `<select>`, `<textarea>` and `<button>` in a system font,
`-webkit-small-control`: Arial on every platform, at the default size less
2pt, 13.33px, whatever the text around it is set in. Gecko's `-moz-field`
is a system font too. The system here is the palette, so a control is set in the theme's
`fontFamily` and at its `fontSize`, the face and the size core's widgets
draw their text in, and not in its parent's. A document's form is then the
window's around it, and the box a control is measured into is the size of
the widget mounted in it: the widget is handed that face and size, so a
`<ThemeProvider>` inside the window that names them reaches its caption as
well as the measurement. The `fontFamily` and `fontSize` props do not move
it, since a host sets those to the face it reads pages in and to the web's
16px `medium`. A `<textarea>` is `monospace` in Chrome, the generic a
`<pre>` is set in, and so is set in `monoFamily` here, at the theme's size.
A page that sets a control's font itself — `font: inherit`, which a CSS
reset gives every control, for one — has it, as it does in a browser, which
draws a control it leaves native in the page's font too: the box is
measured in that face and size, and the widget in it draws in them, framed
by the palette or bare in a box the page drew. A button or a select in the
page's font is core's drawn control on every backend, since a native bezel
sets its title at AppKit's size whatever it is handed. A `<meter>` and a
`<progress>` keep their parent's font, as they do in Chrome.

**A control sits on its line as Chrome's does.** A field, a select, a
button and a text area have no margin, a checkbox `3px 3px 3px 4px`, a
radio button `3px 3px 0 5px` and a range `2px`, and each is on its line's
baseline: a field, a select or an input button by the text it shows, its
face's line centred in its content box, so the label beside it reads on
one line with what is typed; a checkbox, a radio button and a range by
their border box's bottom, their bottom margin hanging under the line; a
text area, which scrolls, by its bottom edge; and a meter or a progress bar
a fifth of an em under it. A page that spaces its form itself sees the
spacing it wrote, and one that spaced nothing sees a browser's.

A widget is drawn at the opacity its element and every ancestor come to,
and at 0 not at all while it still takes a press, as the element does in a
browser: a CSS-only dropdown lays an invisible checkbox over its label, and
a press anywhere on the label opens it, since a checkbox's widget takes its
element's whole box. A `visibility: hidden` control is not mounted.

A widget is cut where the document cuts its element. The document does not
paint it, so what clips the element is handed over with its rectangle: its
own `clip`, and the boxes around it that clip their overflow or are cut to
a `clip` of their own, from its containing block up — an absolute control
is outside a box that clips where its containing block is, as its element
is (CSS 2.1 11.1.1 and 11.1.2). So the field of a panel folded to
`height: 0; overflow: hidden` is not drawn over the page, and a control a
page hides for a screen reader alone — a pixel square under
`clip: rect(0, 0, 0, 0)`, as Radix lays a native `<select>` beside the
picker it draws — shows nothing and takes no press. It is still mounted:
it is hidden from the eye, and not from the keyboard or an assistive
technology. A checkbox, a radio, a select or a submit button the page gave
an `overflow` other than `visible` is cut at its own border box as well: a
browser paints no control past it, and a widget has a size of its own. A
text field cuts its own text and is left alone, and a widget nothing cuts
is not clipped at all, so its focus ring shows around it. A `clip-path`
cuts a widget as it cuts the element, its own and every one around it,
whatever the control is positioned from: one under Tailwind 4's `.sr-only`,
`clip-path: inset(50%)`, shows nothing. It is cut to the path's rectangle,
or to the one around a polygon; the corners a `round` gives it do not round
a widget, nor does a polygon slant one.

A `<select>` shows the option it has selected, its first where none is
marked, and nothing where it has no options — not the "Select…" core's
`<Select>` prompts an application's user with.

**A text field's focus is its element's.** An `<input>` or a `<textarea>`
whose widget takes the focus — from a press, Tab, its label or
`autofocus` — is `:focus` and `:focus-visible` (a text field always shows
its ring, in a browser as in core), and every element around it
`:focus-within`, until the focus goes. So a page's focus styles show:
github.com's login field takes Primer's accent border and inset shadow,
where it kept its grey border. The field's ring is its element's
`outline`, which the document draws round the border box — the UA sheet's
`:focus-visible { outline: auto 1px -webkit-focus-ring-color }`, Chrome's,
which is the palette's ring — and
the widget draws none of its own, so a page's `outline: none` takes it
away and a ring of the page's own takes its place. Core's ring, round a
widget that is only the content box of a field the page drew, stood inside
the page's border. A field the palette draws is rounded as its frame is, so
its ring is too. A caret in a field the page drew is the page's text
colour, as `caret-color: auto` is in a browser; `caret-color` itself is
not read. The other controls are core's components, which keep their focus
to themselves and draw their own ring: a `<select>`, a checkbox, a radio or
an `<input type=submit>` is never `:focus`. Focus moving restyles what it reaches
where it is, as a hover does ([Performance](#performance)) — a click into a search field is no
restyle of the article around it.

A control with a negative `tabindex` takes the focus — from a press, from
its label, from `autofocus` — and is no Tab stop, as HTML has it (6.6.3).
One with `aria-hidden="true"` on it, or on an element around it, is left
out of the accessibility tree, and still takes the focus, as it does in a
browser. The two are how a page keeps a control for its form alone: the
native `<select aria-hidden="true" tabindex="-1">` Radix lays beside its
picker was a Tab stop nobody could see. A radio button's `tabindex` is not
read: core's `<Radio>` hands no props to the node that takes the focus, as
its other widgets do. Nor is a `tabindex` of zero or more, which asks for a
place in an order that is the application's: a page's control does not go
ahead of the window's own.

A `<button>` is the exception, because its content is the document's: an
icon, a label in spans, a pill of the page's own design — most of the
buttons on the web — which a widget's text label drew as "Button". It is
laid out and drawn like any box, in the palette's control look where the
page leaves it alone. A background or a border of the page's, a radius
among them, or an `appearance` of `none` where that is the value that
wins, takes that look off, as each takes a button's native look off in
Blink, and what is left are Chrome's UA edges:
1px above and below the label and 6px beside it, a 2px outset border,
square corners and a border box. That is what a page that styles its
buttons builds on — Codex sets the side padding of Wikipedia's search
button and a 32px minimum, and leaves the rest to the browser — where the
palette's padding stood the button taller than the field beside it. Its
content is laid out as HTML's rendering section has a button's (15.5.5): in
a formatting context of its own, whatever the button's `display`, and
centred down the button's content box where that is the taller — a height
or a least height of its own, or one a flex box, a grid or a pair of
offsets stretched it to — and at the top where the content is the taller.
A button set `display: flex` or `grid` is that instead, its content where
its own alignment puts it. A
press on it is reported through
`onControlChange`, with its `value`, as a widget's is, and then does what
the button does — submits its form, resets it, or nothing for
`type=button`. It takes the focus from the keyboard as a link does, and
Enter or Space presses it (see [Focus and the
keyboard](#focus-and-the-keyboard)). Its text, like every control's,
keeps none of the letter and word spacing, the line height, the case, the
indent or the shadow of the text around it, as HTML's rendering section has
it: a button in a body of `line-height: 1.5` is its own font's line tall.
Its `display` is what HTML's button layout makes of the one it was given:
a flex box or a grid is that, `inline` and `inline-table` are an
`inline-block` — a button is never an inline box, broken around the blocks
in it — and `list-item` and `table` are a block, with no marker and no
cells; a table's part is left what it is. And its `width: auto` is
`fit-content`, as the same layout has it: a button set `display: block`,
`flex` or `grid` is as wide as its content and not as its containing block,
within its `min-width` and `max-width` and the room its margins leave, and
`auto` margins share what is left, so `margin: 0 auto` centres it. A flex
box and a grid still stretch a button that is their item, and two offsets
an absolute one, as they do in Blink.
An `<input type=image>` is drawn the same way, as its image, and submits
the point it was pressed at; until its image arrives, or where it is
declined, it is a button saying its `alt`, so it can be pressed either way.

**A text field the page styled is the page's to draw.** Give an `<input>`, a
`<textarea>` or a `<select>` a border or a background of its own, or
`appearance: none`, and the document paints that box, as a browser drops a
field's native look for the author's; the widget is mounted bare inside its
content box, with no frame or fill, and writes in the element's own colour
and font, which the author chose to go on that background. Its size is then
its text's, and the border and padding around it are the author's. A
`<select>` keeps its arrow, in that colour, as a browser keeps one on a
select the page gave a border or a background, and loses it at
`appearance: none`, where the page draws its own — as a background image,
most often. Its widget is core's `<Select>` restyled through its
`labelStyle` and `chevronStyle` slots, which also make it the drawn trigger
on every backend: under a native popup bezel the page's box would have
AppKit's drawn over it. `appearance: none` is how a design system writes
every field it has, often with neither a border nor a background. A field
with none of the three keeps the theme's frame, and so does every
`<input type=submit>`: core's `<Button>` draws its own label.

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
covers the whole canvas, and the root box stands in for the `<html>`
implied around it. That is the root element, whose margins collapse with
nothing (CSS 2.1 8.3.1), so an `html { margin-top }` is set above the
body's own top margin, as with an `<html>` written in the markup — where a
fragment's root box, standing in for a body, has its top margin collapse
with its first block's, as a body's does. A document that writes `<html>`
gets the body element HTML's parser would have made — the first thing in it that is not
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
context's, which reorders the card's layer; and a transform on a box that
had one, which moves, turns or scales the card and what is in it where it
is — so the card lifts or grows, its shadow widens and it rises over its
neighbour without the document being built or laid out again. The repaint is the ink that
changed, what the boxes drew before and what they draw after, not the
document. The boxes that go with an element go with it: the text in it,
the anonymous boxes made around what is in it — the text of a link laid out
as a flex row is in one — and its `::before` and `::after`, styled again by
their own rules, which may test the hover themselves.

**A `:hover` is found wherever a selector tests it.** Inside `:is()`,
`:where()` or `:not()` it names an element as it would outside: the one the
function is written on, where the entry is one compound, and an ancestor or
an earlier sibling of it where the entry has combinators. Tailwind 4 writes
every `group-hover:` as `:is(:where(.group):hover *)`, every `peer-hover:`
with a `~` in the same place, and its typography's links as `.prose
:where(a:hover):not(…)`; read as selectors no compound could be named in,
any one of them made every move of the pointer build the document again —
half a second a move on nextjs.org's blog at 2x on macOS, six moves
answered a second, where the frame that repaints a move is now a
millisecond. A `:has()` that tests the hover is
an anchor above it, in a function or out of one. A sibling combinator
reaches the later siblings of the compound it follows and of no other, so
one `.peer:hover ~ *` in a sheet does not make a hovered table row restyle
every row after it. Of the elements a move reaches, only those the rules
testing `:hover` answer differently for than before, or whose parent's
style changed, are styled again; the rest of a hovered card or row keep
the styles they have. Only a function that takes no plain selector list —
`:nth-child(… of :hover)` — is left as one that could reach anything.

**What a hover cannot restyle in place, it builds again with the other
styles kept.** Text set bold on hover, an `opacity`, a `display`, content a
hover gives a `::before`, a list marker the element colours, a translation
that would make a box the containing block of what is in it: the boxes are
built and laid out again, as every hover's used to be. But the move reached
the same few elements, and every other element's style is what it was, so
the build takes those from the tree it replaces and matches selectors for
the ones it reached alone. Matching was most of such a build: on that blog
a frame of 550 ms came to 150, most of which is the layout. `:active` is never set
here, so a selector testing it changes nothing as the pointer moves.

**A hover waits for a scroll to stop.** Core asks again what is under a
pointer that has not moved after every frame that moved the content
(`hover follows content`, react-x11#793), and while a document scrolls that
is every frame. The document holds the question until the content has been
still for a tenth of a second — the interval WebKit waits before the mouse
move it sends itself after a scroll — and answers it once. What was hovered
stays hovered as it scrolls away, as it does in a browser, and a move of the
pointer itself is answered at once, scrolling or not. The cost this avoids
is every frame's: that blog scrolled at 3 to 5 frames a second under a
parked pointer and 52 with the pointer off the page, and scrolls at 52
under it now. It is a hold and not a throttle because the expensive case is the one
that matters: a hover that builds the boxes again once a rest is a pause
nobody sees, and once every tenth of a second of a scroll is the scroll.

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
list that has no height of its own. What a `clip` or a `clip-path` cuts
away of a box is not drawn, and is not under the pointer either, though the
point is inside the box. Where two boxes overlap, the answer
follows CSS paint order, `z-index` included. A box painted with the
positioned ones is ordered among those of its stacking context however
deep it is, as paint orders it: a `z-index` on a box in a relative box
with none is the page's, a stacking context that is not positioned is
found where it is drawn over the box after it, and what a stacking
context sets below its flow is over the context's own box. What the
lines paint — their text, their inline-blocks and images, and the flex
items of the flow — is ordered by the document as paint orders it: the
word drawn over an inline-block is under the pointer, and a flex item is
over the background of a block after it. An infobox
floated out of one section and hanging over the next keeps its links, and the next
section's box does not take them. A box that is not visible is not under
the pointer, and nor is one with `pointer-events: none`: the pointer
passes through it to what is, and a box inside it that sets either back
is still found. A closed menu laid over a page, hidden until it opens,
takes nothing from the page under it.

**Nesting is capped at 256 elements, as Blink's parser caps it at 512.**
Everything from the cascade to paint recurses on tree depth, so a
degenerately nested document — a few hundred unclosed `<div>`s, a runaway
template — would otherwise be a stack overflow far from its cause. The
parser puts what is opened deeper into the element at the cap, as Blink's
does, so what is lost is the nesting and not the content; and the box
builder still stops at 512 boxes, counting the anonymous boxes a table
builds round each level, and drops what is deeper: a `display:
table-cell` in another is four boxes a level, a table, a row group, a row
and the cell, so it stops 128 cells deep. Documents this deep are not
documents.

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

**A turning box is painted once while it turns.** On X11 a turned box
with text in it is painted on a surface, and the surface drawn through
its matrix; every frame of an animation painted it again, a card and all
it holds sixty times a second for pixels that had not changed. A box whose
transform or opacity is animating keeps its surface while it animates —
eight million pixels of them at most, and none larger than a quarter of
that — and a frame draws it through the new matrix. On the in-process
server a frame of a turning card went from 17.3 to 10.1 ms, and of a
growing one from 13.9 to 6.2 ms. What is left of a turning card's frame is
the surface resampled through its turn, and the document repainted under
it, which [the design document](../prd-html-animations.md)'s retained
background is about.

**A faded element is a group, and a fade a composite.** On X11 and
Wayland an element under full opacity that draws two things that can
overlap is painted on a surface and the surface faded, and a fading one
keeps its surface, so a frame of a fade went from 8.0 to 3.8 ms on the
in-process server. A still surface no larger than a card's — 128 thousand
pixels — is kept as well, so a repaint of 24 turned cards went from 40.3
to 30.0 ms. Being a group costs what drawing the surface does: a repaint
of 24 faded cards went from 13.9 to 18.0 ms there, where it drew each
thing faded and showed each through the other. An element that draws one
thing is faded as it was, but for text on X11 and Wayland, which is faded
now where it was drawn at full strength, and a page that fades nothing
paints as it did.
The macOS context drew a faded card's group in twice the time it took to
draw the card again — 3.4 ms a frame of a fade, where it had been 1.7 —
because CoreGraphics draws an image under an alpha at some fifteen times
its cost at 1 (react-x11#810). Over a context that draws a surface's
pixels scaled by the alpha instead (`fadesSurfacesCheaply`), the group is
the cheap way as well as the right one: on macOS a repaint of 24 faded
cards went from 3.7–5.5 ms faded a thing at a time to 2.4–4.4 grouped, and
a frame of a fade from 0.65–1.2 ms to 0.39–0.73. A native context that
does not say so is not handed a group, and a page paints there as it did.

**On macOS an animation a layer carries costs no frame.** A page with a
CSS fade on a panel and a CSS turn on a card, over react-x11's sprites and
a bridge that takes a matrix: two seconds of both painted 113 window frames
and 113 paints of the document on the clock, and none of either lifted, the
render server's opacity and turn moving under them. Sampling a part's frames
is the cost instead, once: a style computed per frame of a cycle, sixty for
a second's animation, kept for as long as the document draws and lays the
element out as it did.

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
time, and none of a secure page's stylesheets or fonts over an insecure
connection, which a browser blocks as mixed content (its images are asked
for over a secure one instead). A form's submission through `onSubmit` is a
navigation like a link's: a GET goes to the URL it wrote, and a POST sends
its body, with the `Origin` and `Referer` of the page it was on, and becomes
a step of the history that Reload sends again. A tab shows the page's
`<title>` and its icon; Ctrl+T (⌘T on macOS) opens one. It is where the
component's policy — nothing fetched, nothing
run — meets an application's: the browser fetches what a page asks for and
runs none of its scripts.

[domhandler]: https://github.com/fb55/domhandler
[domutils]: https://github.com/fb55/domutils
[css-select]: https://github.com/fb55/css-select
