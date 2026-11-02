# Office documents

**Status: design.** `<Pdf>` is built and this document is how it was chosen. Word,
PowerPoint and Excel are not built. Everything here is written so that the work
can be picked up from this page alone: what was decided, what was measured, what
was proved, and what is still a guess.

The constraints it was all held to:

- Stand on existing parsing code rather than write it.
- Never go through HTML. No docx to HTML to `<Html>`.
- Performance first: interaction and time to pixels in the viewport.
- Rendering first. Authoring waits unless it turns out to cost little, and it
  does not ([Why reading comes first](#why-reading-comes-first)).

## Where this stands

| Format | What to stand on                                  | Direct draw                                                                           | State                  |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------- |
| PDF    | PDFium, as `@embedpdf/pdfium`                     | Tiles of pixels from a thread, composited by one element                              | **Shipped**            |
| docx   | `@silurus/ooxml`                                  | Its own layout and painter, through a small adapter, on a `Surface`                   | **Proved on X11 only** |
| pptx   | `@silurus/ooxml`                                  | The same                                                                              | **Proved on X11 only** |
| xlsx   | `hucre` for the file, `numfmt` for displayed text | A grid element that draws the cells in view; `@silurus/ooxml` is 9× too slow for this | Measured, not built    |

The one result that shapes the plan: **`@silurus/ooxml` paginates and paints a real
Word form on react-x11's real 2D context, correctly, with a dozen lines of
adapter.** See [The adapter](#the-adapter). So the first office viewer is a few
hundred lines over `<Pdf>`'s view, not a layout engine.

What is **not** known, and should be settled first when this work resumes:

1. Whether the painter holds up on the Cocoa backend. It has only run on the
   in-process X server.
2. Whether a page can be painted without a frame paying for it. Painting needs the
   real context, so it is on the UI thread; see
   [Where the work runs](#where-the-work-runs).
3. Whether `hucre` runs on Node 20. It declares Node 24 or newer, and this package
   supports 20.19.
4. Fidelity against real Office. There is no Word here. The renders were compared
   with `@silurus/ooxml`'s own output on `@napi-rs/canvas`, by eye.

## What `<Pdf>` established

### Pixels from an engine beat a description of them

The obvious design was pdf.js: take its operator list and draw it through the 2D
context. It was measured against engines that draw for themselves before anything
was built. On an arm64 Mac at Node 26, median per page over the first twelve pages,
each engine at 2x:

| Document                 | pdf.js, list only | PDFium, pixels | MuPDF, pixels |
| ------------------------ | ----------------: | -------------: | ------------: |
| `tracemonkey.pdf`, 14 pp |            7.2 ms |        11.6 ms |        7.8 ms |
| PDF 32000 spec, 756 pp   |            3.3 ms |         6.5 ms |        3.4 ms |
| Xcode licences, 228 pp   |            2.3 ms |         7.6 ms |        3.9 ms |
| `TAMReview.pdf`, 23 pp   |            2.7 ms |         7.3 ms |        2.9 ms |
| 400,000 paths on a page  |          2,544 ms |       3,273 ms |      3,624 ms |

The list column is only the parse. Everything PDF can do would still have to be
drawn from it, through a rasterizer slower than either engine's, and written and
kept here: shadings, soft masks, blend modes, patterns, Type 3 fonts. Finished
pixels from an engine cost two or three times the list on an ordinary page and
nothing like the work of the alternative.

| Package            | Installed | Licence | Why, or why not                                                                 |
| ------------------ | --------: | ------- | ------------------------------------------------------------------------------- |
| `@embedpdf/pdfium` |    7.2 MB | MIT     | **Chosen.** The whole C API, no dependencies, a 4.6 MB module                   |
| `@hyzyla/pdfium`   |     14 MB | MIT     | The same engine, with a friendlier API that hides what a tile needs             |
| `mupdf`            |     14 MB | AGPL    | As fast or faster, and it reads office files, but AGPL cannot be this package's |
| `pdfjs-dist`       |     37 MB | Apache  | Plus 28 MB of `@napi-rs/canvas`. The parse is good; the draw is the problem     |

`@embedpdf/pdfium` won on one call: `FPDF_RenderPageBitmapWithMatrix` draws part of
a page into a buffer we name, which is a tile. Through it, on those documents: 32 ms
to start the module, 1 to 2 ms a page to load, 1.5 ms for a 512-pixel tile of a
parsed page, 1.4 ms for one at 12x, since a deep tile holds less, and 2 to 4 ms for
a page's characters and boxes.

### What the view costs

Measured with `scripts/bench/pdf.tsx`, a 1000 by 800 window.

| Backend          | Paint, scrolling | Upload, a tile | Flick of 24,000 px/s                               |
| ---------------- | ---------------: | -------------: | -------------------------------------------------- |
| A real Mac at 2x |          0.23 ms |         0.5 ms | No paint with a tile missing, on the 756-page spec |
| Xvfb at 1x       |  0.05 to 0.15 ms |    1.5 to 4 ms | 4 of 27 paints on a 14-page file                   |

The Mac's numbers were taken before the last fixes to the tile key and the page
cache, and were not taken again. The spread on Xvfb is the machine's load, which
was 8 to 12 at the time. A whole first view on Xvfb took 150 to 190 ms after load on
those documents, and 2.3 s on the 400,000-path page. Scrolling that page while its
tiles came in, the longest tick of the UI thread stayed under 50 ms, which is what
the thread is for.

### What carries over to every other format

`src/pdf/node.ts` is, under its name, a viewer of pages:

- pages stacked in a scroll, placed on whole pixels (`layout.ts`);
- a blit for a scroll, a stretch for a zoom, new tiles when the wheel rests;
- a short queue asked of the view, not of a list of requests;
- a surface cache with a pool, a selection, thumbs and keys.

None of that knows it is a PDF. It asks a `PdfEngine` for sizes, tiles, text and
links, and the next format is the next engine. See
[The shape of the work](#the-shape-of-the-work).

## Why reading comes first

Reading is forgiving and writing is a contract.

A reader may be partial. What it does not understand it can leave out, and the
reader of the document loses a shape. **A writer may not.** Saving a file that was
opened means keeping everything in it that the model does not understand: revision
marks, custom XML, SmartArt, a field code, a macro signature. So a writer either
holds a model of everything in the format, or patches the original XML in place and
holds a mapping from every edit back to it. Either way the failure is silent, and it
is the user's document that pays. Nobody finds out that a save dropped their
comments until a colleague asks where they went.

| Format | Writers that exist                 | What they are                                                       |
| ------ | ---------------------------------- | ------------------------------------------------------------------- |
| PDF    | PDFium itself, `pdf-lib`, `pdfkit` | PDFium exports its edit API and a save; neither has been tried here |
| docx   | `docx` 9.15                        | Generates new files. Does not open one                              |
| pptx   | `pptxgenjs` 4.0                    | Generates new files. Does not open one                              |
| xlsx   | `hucre`, which reads and writes    | The one format where the reader is also a writer                    |

`@silurus/ooxml` is read-only by its charter, so nothing built on it is a base for
editing. Two different things hide under the word authoring, and they cost very
differently:

- **Generating a new file** from an application's data is a thin wrapper over the
  packages above and needs nothing from this one. An application can do it today.
- **Editing a file in place** is the contract above, per format, for as long as the
  formats live.

So: no authoring here until a real application asks for a specific part of it, and
then the smallest part. Filling in a PDF form through PDFium's own form environment
is the likely first one, since PDFium keeps the file's integrity and the risk stays
with the engine. It is also where a document's JavaScript would start to run, so it
needs a decision of its own.

## docx and pptx: `@silurus/ooxml`

Not on the first list of candidates; it came up searching npm. A read-only viewer
with its parsers in Rust compiled to WebAssembly, no dependencies, 21 MB installed,
6 of it WebAssembly, MIT, version 0.89.7 when this was written.

Everything else leaves the cascade to the caller, and the cascade is most of what
makes these formats hard. In `heading123.docx` a run with no formatting of its own
sits in a paragraph styled `Heading1`:

| Library                    | What the run says                                                  |
| -------------------------- | ------------------------------------------------------------------ |
| **`@silurus/ooxml`**       | `bold: true, fontSize: 16, color: "345a8a", fontFamily: "Calibri"` |
| `officeparser`             | Resolved as strings, with no font                                  |
| `ooxml-core`               | Nothing, but exports `resolveRunFormatting`                        |
| `@eigenpal/docx-js-editor` | Nothing. The style is in a table                                   |
| `@stll/folio-core`         | Nothing. The style is in a table                                   |
| `mammoth`, `docx-preview`  | Nothing                                                            |

The same goes for a deck's placeholders, which are resolved through the layout and
the master. Groups are flattened into slide coordinates.

### The numbers

On `bug65649.docx`, a 12.1 MB `document.xml` of 15,935 paragraphs, and
`HowWeRefactor.pptx`, 28 slides and 2,031 shapes. A busy box: ignore differences
under 20%, and trust RSS over heap.

| docx                       |    Parse |      RSS | 107 real files | Text kept | Style resolved |
| -------------------------- | -------: | -------: | -------------: | --------: | -------------- |
| **`@silurus/ooxml`**       | 2,019 ms |   517 MB |            106 |    99.96% | **yes**        |
| `mammoth`                  | 1,305 ms |   752 MB |            105 |     99.9% | no             |
| `docx-preview` + xmldom    | 1,504 ms |   882 MB |            105 |     99.2% | no             |
| `@eigenpal/docx-js-editor` | 1,705 ms |   461 MB |            105 |     98.3% | no             |
| `officeparser`             | 2,177 ms | 1,178 MB |            106 |    99.98% | partly         |
| `@stll/folio-core`         | 3,508 ms |   502 MB |            105 |     99.9% | no             |
| `ooxml-core`               | 3,683 ms | 1,203 MB |            102 |     99.3% | by calling it  |

| pptx                     |    Parse |    RSS | 84 real decks | Layout resolved |
| ------------------------ | -------: | -----: | ------------: | --------------- |
| **`@silurus/ooxml`**     |   379 ms | 253 MB |            83 | **yes**         |
| `pptxtojson`             |   478 ms | 251 MB |            79 | yes, as HTML    |
| `officeparser`           |   831 ms | 483 MB |            82 | partly          |
| `@pptx-glimpse/document` | 1,241 ms | 421 MB |            83 | paragraphs only |
| `@pagus-kit/core`        | 1,730 ms | 248 MB |            83 | yes             |
| `ooxml-core`             | 1,910 ms | 295 MB |            83 | yes             |

A median real docx takes `@silurus/ooxml` 3 ms; the big one is an outlier.

### The adapter

`@silurus/ooxml` lays out and paints as well as parses. `openDocxDocument` paginates
and `renderPage` paints; `openPptxPresentation` and `renderSlide` do the same for a
slide. It was handed real `Surface`s on the in-process X server and did this:

- **Nothing threw**, over a form with nested tables, a footnote and an image, and
  over a deck with custom geometry and a table.
- **Only `fontKerning` and `letterSpacing` are missing** from the context, and
  neither mattered on these files. They are assigned and read as plain properties.
- **Text came out spread apart**, each word the right size and too far from the
  next. This is the one real fault, and the cause is in `AGENTS.md`: ntk draws a
  glyph as it was shaped and puts it where the matrix says. Under the 2.06x scale a
  page is painted with, places were scaled and letters were not. `measureText` is
  not the cause; it answers the same under any transform.

So on ntk text has to be set at the size it is drawn at. This is all of it:

```ts
function fillText(ctx, text, x, y) {
  const m = ctx.getTransform();
  const scale = Math.hypot(m.a, m.b);
  // A context that says `scalesText`, as the native one does, needs none of this.
  if (ctx.scalesText || Math.abs(scale - 1) < 1e-3 || m.b !== 0 || m.c !== 0) {
    return ctx.fillText(text, x, y);
  }
  const font = ctx.font;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = font.replace(/([0-9.]+)px/, (_, n) => `${n * scale}px`);
  ctx.fillText(text, m.a * x + m.e, m.d * y + m.f);
  ctx.restore();
  ctx.font = font;
}
```

With it the form draws as it does on `@napi-rs/canvas`, at 92 ms for its first paint
at 2x and 21 ms for the next. A stray rule at the left of the page is in both
renders, so it is in the file or in their layout and not in the adapter. What the
adapter has to do beyond that:

- **A canvas resizes after its context is taken.** It is made 1×1 and sized later,
  as an HTML canvas may be, so the wrapper's context has to follow a new `Surface`
  under the same object. A stand-in that did not painted a blank page and threw
  nothing.
- **`drawImage` takes the wrapper**, so it has to unwrap to the `Surface`.
- **`loadImage`** goes through `decodeImageBytes` from `react-x11/ntk`.
- **Rotated text is not handled.** The shim only takes a scale. A turned run wants
  the document's own answer to this: on a surface, or as paths (`drawnAsPaths` and
  `paintRaster` in `src/html/paint.ts`).
- **`installOffscreenCanvasShim` and `installImageBitmapShim` take the factory**,
  and the session takes it again.

Other things found by running it, each of which bites:

- **Trim the zip first.** Its preflight refuses anything after the end of the
  central directory, which PowerPoint tolerates and 3 of 84 decks have, the largest
  among them. It took pptx from 80 of 84 to 83.
- **It finds out which fonts exist by measuring.** A family that measures the same
  as a control named `__ooxml_missing_font_control_…` is taken as missing, at 200 px
  and 1000 px. So what `app.fonts` answers for a missing family decides substitution,
  and ntk's answer for a name nobody has is a guess (see "A document's fonts are
  registered under names nothing else has" in `AGENTS.md`). Worth a test on a machine
  with no Calibri, which is every Linux box.
- **`measureText` is hot**: 5,546 calls for that one page. It goes through `app.fonts`,
  so its cost is ntk's or CoreText's and it is on the UI thread.
- **Its parse blocks the thread it is on.** It was run on a worker and the model
  crossed by structured clone: 2,061 ms in the worker, then a 177 ms stall receiving
  it for the big docx, and 31 ms for the big deck. A median file needs no worker.
- **A bug to file**: on a layout with two title placeholders it took line spacing
  from the wrong one, 80% where the master says 100%. It matches by type before
  `idx`.

### The risk in depending on it

It is one author's, its own README says AI agents write the code, and it made 161
releases in six months, so it is the riskiest dependency in this package by some way.
**Pin it exactly, as an optional peer**, the way `ondine` and `quico` are, with its
types written out and a dynamic `import()`, and never read a field starting `__`. If it
goes away, `@stll/folio-core` is the best of the rest: a real model and a headless
layout, at 53 MB with ProseMirror and Yjs as required peers. That risk is also a reason
to keep the adapter thin and the view ours, so that what is thrown away is a page's
worth of code.

Its limits are on by default, 250,000 cells a sheet and 128 MiB an entry. Keep them for
anything that comes from outside.

## xlsx: `hucre` and `numfmt`

A sheet is not pages, and the fixed-layout painter is the wrong tool: `@silurus/ooxml`
took 30 s on the big file, nine times `hucre`.

On `big-200k.xlsx`, generated: 200,000 rows by 12 columns, 2.4M cells, 204k shared
strings, 104 MB of sheet XML, 24 MB on disk. All readers agreed on the cell count and
the sum of every number, so nothing below is a reader skipping work.

| Reader                         |        Parse |        RSS | 322 real files |
| ------------------------------ | -----------: | ---------: | -------------: |
| _Hand byte scanner, streaming_ |     _511 ms_ |   _224 MB_ |                |
| _htmlparser2 `Parser`_         |   _1,911 ms_ |   _493 MB_ |                |
| **`hucre`, styles**            | **3,289 ms** | **804 MB** |        **319** |
| `@xlsxflow/core`, stream       |     3,468 ms |     198 MB |            320 |
| `@e965/xlsx`, styles           |     5,940 ms |     788 MB |            320 |
| `openjsxl`, styles             |     6,054 ms |     528 MB |            318 |
| `exceljs`                      |    11,269 ms |   1,219 MB |            300 |
| `@silurus/ooxml`               |    29,925 ms |     554 MB |            313 |

`hucre` is the only one near that speed that keeps fonts, fills, borders, theme
colours, column widths, row heights, merges, frozen panes, hidden rows, images,
charts, conditional formats, rich text and comments. A re-run here on a loaded machine
came to 4.4 s and 971 MB, which is the 20% this box can move. MIT, no dependencies,
3.5 MB. It reads with `readXlsx(bytes, { readStyles: true })`.

- **Do not write a thin reader over `fflate` and `htmlparser2`.** It costs about what
  `hucre` costs, 1.6 to 2.3 s, and keeps far less. The one thing clearly faster is a
  hand byte scanner, at a sixth of the time and under a third of the memory; it is
  the fallback if opening a 200k-row sheet styled in under a second becomes a
  requirement, and its styles would have to be read apart, which is untested.
- **Do not add `fflate`.** `node:zlib` is 4 times faster on Node and 10 on Bun: 138 ms
  against 555, and 137 against 1,347. `src/html/woff2.ts` already reaches it. A central
  directory reader is 25 lines.
- **Do not use `hucre.resolveThemeColor`.** It reads the list in file order, and
  SpreadsheetML swaps the first two pairs: `theme="1"` is dark 1, so default black text
  comes back white. Six lines of our own, then file it.
- **Do not use `hucre.formatValue` for what a cell shows.** It scored 92 of 190 against
  Excel's own `TEXT()` results held in POI's test workbooks. `numfmt` 4.1.1 scored 161
  (`@e965/xlsx`'s SSF 158), is MIT, 1.2 MB and took 27 ms for 438 cases. It has no 1904
  date system, so those dates are shifted by 1,462 days first.
- **Its streaming reader yields values and no styles**, first rows in 229 ms. A styled
  sheet needs the whole `readXlsx`, on a thread: a stall over 1.5 s was seen. `maxRows`
  does not help: 100 rows still took 2.0 s. If that hurts, `@xlsxflow/core` streams styled
  rows in 180 ms with a longest stall of 16 ms, but keeps no row heights, conditional
  formats or charts.
- **Node 24.** `hucre` declares `>=24`, and this package `>=20.19`. It ran on 24.12, 26.0
  and Bun 1.4. Node 20 was not tried, so either it works or the page says so.

**The element draws.** A sheet is a two-axis scroll over millions of cells with a style
each, frozen panes and a zoom, which is a transform: `<Table>` composes rows and is the
wrong shape, and `<vtterm>` is the right one, a registered element that draws what is in
view from a compact store. Keep cells columnar in typed arrays, and format a cell's text
as it comes into view rather than as the file is read.

## Formats not chosen, and why

**xlsx.** `exceljs`: 192 dependencies and 22 failures on real files. `@e965/xlsx` and
`xlsx`: no fonts, borders, images or conditional formats on read. `read-excel-file`: values
only. `xlsx-format`: 6.8 to 11 s. `excel-bridge`: 1 GB, and no conditional formats, images
or charts. `@office-kit/xlsx`: crashes on a real file. `openjsxl`: the closest, but no charts,
and styles a cell at a time took 6 s.

**docx.** `docx-preview`: needs a `DOMParser`, and its model is CSS-keyed. `mammoth`: no colours,
spacing, table widths or borders, sections, floats or headers; built for semantic HTML, and drops
what it does not map. `@eigenpal/docx-js-editor`: lost all 20 sampled words of a shapes document
with no error. `officeparser`: 149 MB, no table widths or borders. `docx4js`, `docx2js`: no style
cascade. `ooxml-core`: 171 MB and 1.2 GB of RSS.

**pptx.** `pptxtojson`: HTML strings as its text model, which is the path ruled out.
`pptx-json-parser`: a broken wrapper round that. `@s8fy/pptx-parser`: PolyForm Noncommercial, not
run. `pptx-preview`: will not import in Node. `@aiden0z/pptx-renderer`: its render is the DOM.
`pptx-automizer`: a generator. `@pagus-kit/core`: 4.6 times slower, theme fonts unresolved.
`pptx-viewer-core`: 172 MB. `@pptx-glimpse/document`: no resolved run style.

**LibreOffice** was not evaluated, since none is installed here. It is the fidelity
rung if one is ever wanted: `soffice --headless --convert-to pdf` through `ProcessHost`,
and the result into `<Pdf>`. That is the `<MediaPlayer>` posture, a program that may not
be there and a `fallback` where it is not, and it would be slow to open and exact
afterwards. MuPDF reads office files too; it was not evaluated, since AGPL rules it
out here anyway.

## The shape of the work

### One view, several sources

"A shared module is a directory too": when a second format arrives, the view leaves
`src/pdf/` for `src/pages/`, with `registerPageView()` called at each component's own module
scope, as `src/richtext/` does, and `PdfEngine` becomes a `PageSource`:

```ts
interface PageSource {
  sizes: PageSize[];
  /** Pixels from a thread, as PDFium draws them… */
  render?(tile: TileRequest): Promise<TilePixels | null>;
  /** …or a page painted on a surface here, as `@silurus/ooxml` paints. */
  paint?(page: number, level: number, surface: Surface): Promise<void>;
  text?(page: number): Promise<PageText>;
  links?(page: number): Promise<PageLink[]>;
}
```

The fork is `render` or `paint`. `paint` covers a whole page rather than a tile, so its
cache entry is one surface of the page's size at that level, which is a bigger allocation
and a simpler key; at a deep zoom a page surface stops being affordable, and a `paint`
source tiles by clipping and painting again.

### Where the work runs

This is the open question that matters most. PDFium draws on a thread, so a page never
touches a frame. `@silurus/ooxml` paints on the real context, and on X11 that is a
connection the UI thread owns; and its layout measures through `app.fonts`, which is there
too. A dense page's 90 ms is therefore a frame or five.

In order of preference:

1. **Paint outside frames, a page at a time**, as `<Map>` rasterizes between frames, and
   show the page's ground until it lands. Most documents are a page at a time anyway, and
   a page is 21 ms once its layout is done. This is the first thing to try.
2. **Make the painter resumable.** It is not ours, so only by asking upstream.
3. **Paint on a thread with a second font engine and hand over pixels.** That is the
   `<Pdf>` shape, but it means shaping on a thread that has none of the app's font state, and
   whether ntk's text layouts can run there at all has not been looked at. Only if the first
   two fail.

### Order of work

1. **Prove the adapter on Cocoa.** One page and one slide on a real window. The first of the
   open questions above, and the cheapest; do it before anything is designed around it.
2. **`src/pages/`.** Move the view, with `PdfEngine` as its first source and `<Pdf>`'s tests
   unchanged. This is a refactor that proves the seam.
3. **`<Docx>`.** The adapter, the zip trim, a `paint` source, and paint outside frames.
   Selection and links are the part with no answer yet: nothing looked at so far reports where
   a run of text was put. Recording `fillText` calls per page would make a text index that is
   exact by construction, which is the first thing to try.
4. **`<Pptx>`.** Little more than a second `paint` source, plus a slide-at-a-time fit.
5. **`<Sheet>`.** `hucre` on a thread, a new drawn element, `numfmt` in view. Independent of
   everything above, so it can go first if a user wants it first.
6. **What `<Pdf>` left**: find, fonts a file does not embed (`FPDF_SetSystemFontInfo`), and a
   selection that scrolls the pane as it drags.

## How this was measured

The office numbers were taken on 2026-11-02 by a survey run for this document, on an arm64 Mac
at Node 26.0 with a load average near 9, with a fresh process per run and the minimum of one to
three. Of its results, these were run again by hand and held: the `Heading1` run above, the deck
reading, `hucre` on the big file, and the versions and licences. The rest are as it reported them.
Its scripts were not kept, so to repeat it:

- **Corpus.** Apache POI's `test-data/` on GitHub: `document/`, `slideshow/` and `spreadsheet/`.
  107 docx, 84 pptx and 322 xlsx under 3 MB, with fuzz and password cases filtered by name.
- **Big sheet.** Generate one: 200,000 rows of 12 columns of strings, dates, numbers, booleans and
  a formula, with styles and a frozen pane.
- **Silent loss.** Sample up to 300 words from each file's raw XML and look for them in the model.
  It finds whether words survive, not whether they are in the right place.
- **Number formats.** Score against the `Result (expected)` columns of POI's test workbooks, which
  are Excel's own `TEXT()` results.

The PDF numbers come from `scripts/bench/pdf.tsx`, and three things will mislead a repeat of it:

- **Give the window a size with `<window width height>`.** With `style` the window comes up with no
  room for the view, and it reports a zoom of 0.1 and no tiles at all, which reads exactly like a
  broken engine.
- **A paint's gaps are only of its damage.** A view is whole when every tile of it has landed, and
  the first version of the metric said so with two of eight tiles in. The first-view figures from
  before that was fixed were thrown away, which is why this page has none for the Mac.
- **The in-process server says nothing about an upload.** Use a real window or Xvfb.

Nothing here was checked against Word, Excel or PowerPoint. Password-protected office files, right
to left text, vertical text and SmartArt beyond one sample were not exercised.
