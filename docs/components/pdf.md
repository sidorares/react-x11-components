# Pdf

```jsx
import { Pdf } from '@react-x11/components/pdf';

const bytes = new Uint8Array(await readFile('report.pdf'));

<Pdf data={bytes} defaultZoom="width" />;
```

A PDF, read and drawn by [PDFium](https://pdfium.googlesource.com/pdfium/), the
engine in Chrome, as WebAssembly on a thread of its own. It is an optional peer,
so `npm i @embedpdf/pdfium` first; where it is not installed `<Pdf>` is
`status: 'unavailable'` plus `fallback`. It registers one element, `pdfview`,
that composites the tiles the thread draws, and it runs on every backend. Nothing
in it goes through `<Html>`.

Text selects and copies, links go where they say, and a screen reader is told
the text of the pages in view. `<Pdf>` reads no file and fetches nothing: what it
is handed is bytes, and a link to the outside goes nowhere until `onLink` sends
it.

## Props

| Prop           | Type                               | What it does                                                                                                                                        |
| -------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`         | `Uint8Array \| null`               | The file. Copied to the engine, so the array stays yours. A new array is a new document.                                                            |
| `password`     | `string`                           | For a document that needs one. Without it, or with the wrong one, the status is `'password'`.                                                       |
| `defaultZoom`  | `number \| 'width' \| 'page'`      | Where a document opens: a number, 1 being 96 pixels to the inch, or a fit that goes on following the pane until a zoom moves it. Default `'width'`. |
| `engine`       | `PdfEngine`                        | An engine of your own. Default PDFium, on a thread.                                                                                                 |
| `fallback`     | `({ status, error }) => ReactNode` | What shows where there is no document to show: no engine, a password wanted, a file that could not be read.                                         |
| `onLoad`       | `(document: PdfInfo) => void`      | The document opened: its `pages`, `outline` and `title`.                                                                                            |
| `onError`      | `(error: Error) => void`           | It did not. A `PdfOpenError` has a `code`: `'password'`, `'format'`, `'security'`, `'file'` or `'unknown'`.                                         |
| `onStatus`     | `(status: PdfStatus) => void`      | `'loading'`, `'ready'`, `'unavailable'`, `'password'` or `'error'`.                                                                                 |
| `onPageChange` | `(page: number) => void`           | The page a reader is on, 0-based: the one a third of the way down the pane.                                                                         |
| `onZoomChange` | `(zoom: number) => void`           | The zoom moved, a fit's included.                                                                                                                   |
| `onLink`       | `({ url?, page? }) => void`        | A link was followed. One inside the document has already scrolled there; one outside it is yours to send, or not.                                   |
| `ground`       | `string`                           | What shows between and around the pages. Default `#525659`.                                                                                         |
| `thumb`        | `string`                           | What the scroll thumbs are drawn in.                                                                                                                |
| `gap`          | `number`                           | Logical pixels between pages. Default 12.                                                                                                           |
| `cacheBytes`   | `number`                           | What the tiles on hand may hold. Default 256 MB, some twenty laptop screens at 2x. A tile in or near view is never dropped for it.                  |
| `style`        | `Style`                            | The element's style. It grows into the space it has by default.                                                                                     |

## The handle

```jsx
const pdf = useRef(null);
<Pdf ref={pdf} data={bytes} />;

pdf.current.scrollToPage(41);
const text = await pdf.current.selectedText();
```

| Member            | What it is                                                                             |
| ----------------- | -------------------------------------------------------------------------------------- |
| `pageCount`       | How many pages the document has.                                                       |
| `outline`         | The document's bookmarks, `{ title, page, url?, children }`. Hand them to a `<Tree>`.  |
| `scrollToPage(n)` | Bring a page to the top of the pane.                                                   |
| `zoomTo(zoom)`    | A zoom about the middle of the pane.                                                   |
| `fit(fit)`        | `'width'` or `'page'`, followed until a zoom moves it.                                 |
| `selectedText()`  | The selection as text, a promise since it may reach pages that have to be read again.  |
| `node`            | The element, for its `stats`: what was drawn, uploaded and painted, for a measurement. |

## The keyboard and the pointer

The wheel scrolls, and Ctrl or Cmd with it zooms about the pointer. Arrows,
Page Up and Down, Space, Home and End scroll; Ctrl with `+`, `-` and `0` zooms,
`0` to the width. Drag across text to select it, twice for a word and three
times for a line; Ctrl+A takes the document, Ctrl+C copies, Escape lets go. A
selection is offered as `PRIMARY` as it ends, as a terminal offers one. The
scroll thumbs drag.

## Decisions

**A page is pixels PDFium drew, not a description of them.** pdf.js was the
obvious way in, and its operator list could have been drawn here through the 2D
context. It was measured first: on four ordinary documents PDFium takes 7 to
12 ms a page for finished pixels at 2x, and pdf.js 2 to 7 ms for a list of what
to draw, with the drawing still to come and all of PDF's graphics model still to
write and to keep: shadings, soft masks, blend modes, Type 3 fonts. So the
document's look is the engine's, and a page comes out as PDFium draws it. The
numbers are in [the design document](../prd-office-documents.md).

**What a scroll costs is a blit.** A tile is 512 device pixels a side and comes
back in a millisecond or two, moved rather than copied. A scroll moves the pixels
on screen, composites the strip it exposed and draws nothing, so a dense page
scrolls as a plain one does. A zoom composites what is on hand, stretched, and
asks for tiles at the new scale once the wheel has rested, a tenth of a second
later, so a page gets soft for a moment and never blank. A fit does the same
through a dragged window edge.

**The queue is short on purpose.** Three tiles at most are at the engine, and
what to ask for next is worked out from the view as each lands. A flick through
a thousand pages leaves no thousand requests behind it, and what is drawn next
is where the reader is now.

**One thread and one module for the process.** PDFium takes some 30 ms to start
and two documents on a screen want one queue, so `defaultPdfEngine()` keeps one
for the process, and it keeps no event loop alive. Where no thread can start, the
module runs on the application's thread: a heavy page is then felt, and nothing
else changes. **A bundler that moves the module has to carry
`worker-thread.js` beside it**, or that is what happens.

**Nothing runs and nothing is sent.** PDFium here is WebAssembly with no network,
and `<Pdf>` never starts its form environment, which is what runs a document's
JavaScript and its actions. An attached file stays attached. A link to the
outside does nothing until `onLink` does something, as `<Html>`'s `onLink` is
yours, so "render this PDF" never turns into "make these requests".

**`PdfEngine` is public because it is a feature.** A document that is not a file,
or a host that wants PDFium in a process of its own, is an object with `open`,
`render`, `text`, `links` and `close`; everything crossing it is numbers and typed
arrays. `render` is handed a tile in device pixels and answers straight RGBA.

**A selection is the element's own, not the document's around it.** Core's
`selectable` asks an element for all its text up front, and a manual's text is on
a thread, read as its pages come into view. So `<Pdf>` selects for itself and
reads what it does not hold when a copy asks, which is why `selectedText()` is a
promise. A selection does not extend out of a `<Pdf>` into what is around it.

**Text is read from where it was drawn.** PDFium reports a character's box in the
page's own space, whose origin may be anywhere and which `/Rotate` may turn, so
each box is taken through the page's own matrix before it is used. A selection
lands on the ink on a turned page and on one whose media box does not start at
zero.

## What it does not do yet

Each of these is work nobody has done, not a wall:

- **Fonts a file does not embed.** PDFium has its own stand-ins for the base 14,
  and WebAssembly has no system fonts, so a CJK font that is named and not
  embedded draws nothing. poppler finds such a font on the system.
  `FPDF_SetSystemFontInfo` is the seam for a table the application supplies.
- **Find.** There is text to search; there is no find bar and no `find()`.
- **Filling a form, or editing anything.** A form's fields are drawn as the
  document has them. See [Office documents](../prd-office-documents.md) on why
  reading comes first.
- **Scrolling while a selection drags past the pane's edge.** The wheel still
  moves it.
- **A file too large to hold.** The bytes are copied whole to the engine, which
  keeps them for as long as the document is open.

## Example

```bash
npm run examples:pdf -- report.pdf
```

`scripts/bench/pdf.tsx` is the measurement: time to a whole first view, and what a
frame costs through a read, a flick and a zoom, on a real window.
