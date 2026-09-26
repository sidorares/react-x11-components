# `<Html>` against the CSS 2.1 test suite

A record of running web-platform-tests' CSS 2.1 suite through
[`<Html>`](components/html.md) on both backends: what it supports, what the
suite found wrong, what was fixed, and what "a static HTML widget in a UI
toolkit" should support next. Written to be rerun: the runner is in the
repository, and the numbers below are its output.

## The suite, and how it runs

The W3C's CSS 2.1 conformance suite lives in
[web-platform-tests](https://github.com/web-platform-tests/wpt) as
`css/CSS2`: about 9,300 documents across 40 areas — block flow, floats,
positioning, tables, lists, backgrounds, fonts, text, selectors, the
cascade. It is the standard test of CSS's static visual model, which is
exactly the layer `<Html>` is: no script, no network, a document in and a
picture out.

6,214 of its documents are **reftests**: a test and a reference that must
render identically, the reference built the obvious way (a green square as a
`<div>` with a background) and the test the way the feature under test
builds it. That makes the suite automatable without a browser. `<Html>`
renders both, the runner reads back each 800×600 viewport and compares them
pixel for pixel, honouring a test's `fuzzy` allowance where it declares one,
which is how WPT's own runner judges a browser's screenshots.

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/web-platform-tests/wpt.git
git -C wpt sparse-checkout set css/CSS2 css/reference css/support fonts

npx tsx scripts/conformance/run.ts wpt css/CSS2 --out results-x11
npx tsx scripts/conformance/run.ts wpt css/CSS2 --backend cocoa --out results-cocoa
```

X11 runs headless, in react-x11's in-process X server, in about a minute on
8 workers. Cocoa renders into real windows through core's native backend,
four at a time, in under two minutes. `WPT_SHOTS=<dir>` on `wpt.tsx` writes
each test, its reference and their difference side by side.

What the run adapts, and why each is fair to a static renderer:

- **The Ahem font is handed over**, not fetched through `@font-face`, which
  `<Html>` ignores along with everything else that would load. An
  application brings its fonts the same way.
- **XHTML is read as HTML.** Most of the suite is `.xht`, which a browser
  parses as XML; the CDATA markers round a style sheet are the one XML
  construct an HTML parser reads differently, so they are removed.
- **The palette is a browser's**: black on white, links `#0000ee`, a 16px
  serif. The rest of the user-agent sheet is `<Html>`'s own, themed rules
  included.
- **Scripts do not run.** 317 tests need one, and are recorded and skipped:
  `<Html>` never executes a script, by design.

A test passes when the two pictures match. A renderer that draws neither the
test nor the reference passes too; the runner records both-blank passes
separately, and there are six.

## Results

|                       | master, X11 | now, X11    | now, Cocoa  |
| --------------------- | ----------- | ----------- | ----------- |
| reftests run          | 5,895       | 5,895       | 5,895       |
| pass                  | 1,831 (31%) | 2,417 (41%) | 2,212 (38%) |
| **hung the renderer** | **91**      | 0           | 0           |
| threw from paint      | 1           | 0           | 0           |

"Now" is master with the fixes below. The 91 hangs were the renderer looping
for ever inside a render, which freezes an application whole; they are the
first finding, and the most important one.

By area, sorted by the number of tests:

| area                 | master, X11   | now, X11      | now, Cocoa    |
| -------------------- | ------------- | ------------- | ------------- |
| normal-flow          | 217/694 (31%) | 357/694 (51%) | 423/694 (61%) |
| margin-padding-clear | 369/682 (54%) | 448/682 (66%) | 424/682 (62%) |
| positioning          | 129/513 (25%) | 217/513 (42%) | 184/513 (36%) |
| borders              | 255/504 (51%) | 267/504 (53%) | 266/504 (53%) |
| selectors            | 62/468 (13%)  | 70/468 (15%)  | 70/468 (15%)  |
| text                 | 186/381 (49%) | 193/381 (51%) | 181/381 (48%) |
| backgrounds          | 114/336 (34%) | 178/336 (53%) | 112/336 (33%) |
| syntax               | 147/275 (53%) | 152/275 (55%) | 153/275 (56%) |
| tables               | 12/250 (5%)   | 15/250 (6%)   | 15/250 (6%)   |
| floats-clear         | 13/211 (6%)   | 80/211 (38%)  | 56/211 (27%)  |
| generated-content    | 17/205 (8%)   | 17/205 (8%)   | 17/205 (8%)   |
| linebox              | 41/191 (21%)  | 106/191 (55%) | 16/191 (8%)   |
| css1                 | 18/164 (11%)  | 22/164 (13%)  | 11/164 (7%)   |
| fonts                | 45/159 (28%)  | 46/159 (29%)  | 43/159 (27%)  |
| lists                | 12/155 (8%)   | 12/155 (8%)   | 12/155 (8%)   |
| bidi-text            | 4/105 (4%)    | 4/105 (4%)    | 5/105 (5%)    |
| floats               | 17/100 (17%)  | 23/100 (23%)  | 25/100 (25%)  |
| box-display          | 17/86 (20%)   | 20/86 (23%)   | 14/86 (16%)   |
| ui                   | 39/52 (75%)   | 39/52 (75%)   | 39/52 (75%)   |
| visufx               | 3/49 (6%)     | 3/49 (6%)     | 3/49 (6%)     |
| pagination           | 38/43 (88%)   | 41/43 (95%)   | 41/43 (95%)   |
| visudet              | 6/37 (16%)    | 10/37 (27%)   | 11/37 (30%)   |
| cascade              | 12/32 (38%)   | 20/32 (62%)   | 19/32 (59%)   |
| zindex               | 13/29 (45%)   | 13/29 (45%)   | 13/29 (45%)   |
| visuren              | 4/26 (15%)    | 5/26 (19%)    | 5/26 (19%)    |
| abspos               | 3/25 (12%)    | 7/25 (28%)    | 7/25 (28%)    |
| values               | 8/25 (32%)    | 11/25 (44%)   | 7/25 (28%)    |
| sec5                 | 11/23 (48%)   | 21/23 (91%)   | 21/23 (91%)   |
| colors               | 2/19 (11%)    | 3/19 (16%)    | 2/19 (11%)    |
| media                | 10/17 (59%)   | 10/17 (59%)   | 10/17 (59%)   |

Paged media passes because neither a test nor its reference paginates here;
those tests measure nothing about `<Html>`, which has no pages.

## What the suite found, and what was fixed

Eight defects, each fixed with a test that fails without the fix:

1. **A universal selector hung the application.** The specificity scan took
   `*` and `|` for the start of a name and then stepped over none of it, so
   it stood still for ever — inside the render. `* { margin: 0 }` hung it,
   and so did any comment inside a selector, whose own `*`s reached the same
   loop. Present since `<Html>` shipped; 91 tests never finished.
2. **A malformed colour crashed paint.** A functional colour went through the
   cascade unread, and ntk's X11 context throws on one it cannot parse:
   `rgb(foo)` in a stylesheet took the application down. The Cocoa context
   drew black instead. The cascade now asks ntk's non-throwing parser and
   drops what it cannot read, as CSS does with an invalid value. The end of
   a sheet also closes what is open now, as CSS 2.1 4.2 says: `rgb(0, 128, 0`
   as a sheet's last words is green, where the block reader used to cut the
   last character of a block the end cut off.
3. **A comment inside a selector dropped the rule.** `div /* note */ { … }`
   reached the matcher with the note in it; the cascade and selector tests
   annotate every selector with its specificity that way.
4. **Images handed over as bytes never decoded.** `decodeImage` is a named
   export of `react-x11/ntk` and was read off the default export; every
   `{ kind: 'image', bytes }` a host returned drew as an empty frame. A
   seventh of the suite uses a PNG swatch.
5. **A float sat at its formatting context's edge**, not its containing
   block's: outside its parent's padding and outside the body's margin.
6. **A first child's top margin did not collapse through its parent's top
   edge** (CSS 2.1 8.3.1), so `<div><p>` stood a paragraph's margin lower
   than `<p>`. Most of the selector tests nest their paragraph in a div and
   failed by exactly that margin.
7. **`line-height: 0` set lines a tenth of a line apart**: a floor on the
   multiplier. The line-box tests build their squares from glyphs on
   zero-height lines.
8. **Background images were parsed and never drawn**: no request, no paint.
   They are requested through `onResource` and painted per CSS 2.1 14.2.1
   now, and the root's background covers the canvas, so an email's
   `<body bgcolor>` colours the message rather than a box inside a white
   page. Backgrounds went from 96 to 180 of 336 on X11.

And one in ntk, found the same way: **a scaled image faded out over its
outer pixels**, because the server-side bilinear filter sampled past its
edge as transparent. Fixed in ntk 8.12.9 (ntk #392) by clamping to the
edge, as the canvas spec and browsers do; every reference built from image
swatches differed from its test by their rims.

## What `<Html>` supports

From the pass rates of the tests that use each feature, at the fixes above,
on X11. A rate is confounded — a test that uses a supported feature may fail
on another one beside it — so the column is a guide, and the verdict is
checked against the code.

| feature                                            | tests | pass   | verdict                                                                                                                                                                                                                |
| -------------------------------------------------- | ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| block flow, margin collapsing                      | 694   | 51%    | **supported**; empty blocks collapsing through, and clearance, remain                                                                                                                                                  |
| margins, padding, borders                          | 682   | 66%    | **supported**; border-collapse and the `double`/`groove` families are approximations                                                                                                                                   |
| floats and `clear`                                 | 311   | 23–38% | **supported**, with gaps: a float inside a paragraph is placed at the paragraph's top, not its line's                                                                                                                  |
| relative and absolute positioning                  | 513   | 42%    | **partial**: no static position for an absolute box with neither `top` nor `bottom`                                                                                                                                    |
| backgrounds: colour, image, repeat, position       | 336   | 53%    | **supported**; `background-attachment: fixed` is not                                                                                                                                                                   |
| fonts: family, style, weight, size                 | 159   | 29%    | **partial**; the `font-size` failures are not yet taken apart                                                                                                                                                          |
| line height, `vertical-align`                      | 191   | 55%    | **partial**: one line height per paragraph, where CSS gives each inline box its own                                                                                                                                    |
| `white-space`                                      | 217   | 18%    | **partial**                                                                                                                                                                                                            |
| lists and markers                                  | 155   | 8%     | **partial**: markers draw; counters and `list-style-image` do not                                                                                                                                                      |
| CSS tables (`display: table-*`), `table-layout`    | 250   | 6%     | **partial**: HTML tables lay out, and a table's missing row groups, rows and cells are generated; a table part outside a table gets no table around it, and `border-collapse: collapse` is drawn as the separate model |
| `::before`, `::after`, `content`, counters, quotes | 332   | 6%     | **missing**                                                                                                                                                                                                            |
| `::first-letter`, `::first-line`                   | 395   | 1–16%  | **missing**                                                                                                                                                                                                            |
| `z-index` stacking                                 | 152   | 10%    | **partial**: z-order within one parent only                                                                                                                                                                            |
| `clip`                                             | 44    | 0%     | **missing**                                                                                                                                                                                                            |
| bidi: `direction`, `unicode-bidi`                  | 265   | 14%    | **partial**: shaping and the bidi algorithm are ntk's; `unicode-bidi` overrides are not applied                                                                                                                        |
| selectors                                          | 468   | 15%    | **supported** except the pseudo-elements above, which are most of this area                                                                                                                                            |
| cascade, `@import`, `@media`                       | 134   | 57–62% | **supported**                                                                                                                                                                                                          |

The CSS3 subset documents actually use sits outside this suite and is listed
in [the plan](#a-static-html-widget-worth-having) below.

## Cocoa

Cocoa passes 205 fewer tests than X11. 102 tests pass only on Cocoa and 307
only on X11; of those 307:

- **83 are sub-pixel resampling.** At 2x every image is scaled, and
  CoreGraphics' interpolation at a tile's edge depends on where the tile
  lands, so a background drawn a tile at a time differs from the reference's
  `<img>` by at most 32 levels on a few hundred pixels. Nothing a reader
  sees, and a strict comparison counts it.
- **89 are line boxes.** On Cocoa, a glyph taller than its line box is cut
  off where X11 draws it whole and lets it overflow, as CSS does. The native
  `drawLayout` does not clip, so the cut is made above it; not yet found.
- **The rest** — positioning, floats, normal flow — are under investigation;
  the 88 normal-flow tests that pass only on Cocoa point at a metric that
  differs between the two text engines.

## A static HTML widget worth having

What should a UI toolkit's HTML widget render? Not the open web: an
application that wants that embeds a browser. It renders **what an
application is handed**: mail, release notes, help pages, a CMS's output, a
report, a model's answer, a markdown pipeline's HTML. The neighbours define
the range:

| widget                                        | what it renders                                                                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android `Html.fromHtml`                       | inline formatting and a few block tags; next to no CSS                                                                                                                                                                             |
| wxWidgets `wxHtmlWindow`, Swing `JEditorPane` | an HTML 3.2 subset; CSS1 at most                                                                                                                                                                                                   |
| Qt `QTextBrowser`                             | a subset of HTML 4 and of CSS: tables, lists, images, text styles; no positioning, floats only for images and tables                                                                                                               |
| Flutter and React Native HTML renderers       | a CSS subset mapped onto the host's layout: blocks, text, lists, images, tables by plugin                                                                                                                                          |
| litehtml                                      | CSS 2.1's visual model, most of it, plus some CSS3; no script                                                                                                                                                                      |
| mail clients                                  | the de facto standard for HTML an application is handed — tables, presentational attributes, `<style>` with media queries, a CSS3 subset that varies client by client ([caniemail.com](https://www.caniemail.com) keeps the table) |

`<Html>` should sit with litehtml and a mail client's viewer: **CSS 2.1's
static visual model, the presentational HTML mail still uses, and the CSS3
properties real documents rely on.** Not scripting, not paged or aural
media, not animation, and nothing that loads unless the host says so.

In order, each step measured by this runner and, for the CSS3 half, by
WPT's `css-backgrounds`, `css-color`, `css-values` and `css-flexbox`
directories and caniemail's feature list:

1. **Never hang, never throw.** Done for everything this suite reaches. Next:
   run all of WPT's `css/` tree for crashes alone, reftest or not, and a
   fuzzer over the CSS parser — a renderer that can freeze its host is worse
   than one that renders badly.
2. **Generated content**: `::before`, `::after`, `content` with strings,
   `attr()`, counters and quotes. About 330 tests, and used everywhere —
   clearfixes, icons, quotation marks, numbered headings.
3. **Tables as mail uses them**: anonymous table boxes, the collapsing
   border model, `table-layout: fixed`, row groups, captions. About 600
   tests, and the layout of most HTML mail.
4. **The inline formatting model**: a line height per inline box, the
   remaining `vertical-align` values, `white-space`, `font-size` keywords,
   `text-align: justify`, and the Cocoa line-box clip.
5. **The CSS3 that documents use**: `background-size`, `box-shadow`,
   gradients, `calc()`, custom properties (`var()`), CSS Color 4 — which
   needs ntk's colour parser to read `oklch()` and the space-separated
   `rgb()`; Tailwind's output is written in them — and `@font-face` through
   `onResource`.
6. **Stacking and clipping**: stacking contexts across `z-index`, `clip`,
   the static position of an absolute box.
7. **`::first-letter` and `::first-line`**: drop caps and small-cap lead-ins;
   about 400 tests, most of them Unicode punctuation classes.
8. **Bidi overrides**: `unicode-bidi: embed | bidi-override | isolate`.

## Lessons

1. **A conformance suite finds robustness bugs first.** The first full run
   hung on 91 documents and crashed on one — found in minutes, after the
   component had shipped with every one of them. Run a standard suite before
   believing a renderer is robust, and run it for hangs before pixels.
2. **Reftests pass by accident.** A feature neither the test nor its
   reference exercises passes on a renderer that lacks it; fixing one half
   turns such passes into failures. Diff every run against the last, test by
   test, and read the regressions before trusting a rate.
3. **Count the backend difference, not the backend.** A test passing on one
   backend and failing on the other is a backend bug with its reproduction
   attached; that list is worth more than either pass rate.
