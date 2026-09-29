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

- **The Ahem font is handed over.** A test that links `/fonts/ahem.css`
  loads it through its `@font-face`, which `<Html>` asks the host for as
  `kind: 'font'` and the runner answers from the checkout, as WPT's server
  would; Ahem is also registered under its family name for a test that
  names it without the sheet, the way an application brings its fonts.
  (Answered as an image before the runner knew the kind, the face was
  refused, and 569 tests that link the sheet fell back to the default serif.)
- **XHTML is read as HTML.** Most of the suite is `.xht`, which a browser
  parses as XML. Two XML constructs in a style sheet read differently to an
  HTML parser: the CDATA markers round one, which are removed, and the
  entities outside them, which XML decodes and HTML leaves be — a
  selector written `div &gt; span` is a `>` to a browser — so a style
  sheet's are decoded first (from round 86).
- **The palette is a browser's**: black on white, links `#0000ee`, a 16px
  serif. The rest of the user-agent sheet is `<Html>`'s own, themed rules
  included.
- **Scripts do not run.** 317 tests need one, and are recorded and skipped:
  `<Html>` never executes a script, by design.
- **Pages are decoded, and stylesheets handed over as bytes**, as WPT's
  server and a browser do it. The runner finds a page's encoding from a
  byte order mark, the charset its `.headers` file serves it with, or its
  XML declaration or `<meta>`, and passes it on as the `charset` prop. It
  hands each stylesheet over as bytes, with the charset from its own
  `.headers`, and `<Html>` decodes it as CSS says.

A test passes when the two pictures match. A renderer that draws neither the
test nor the reference passes too; the runner records both-blank passes
separately, and there are six.

The runner also looks for crashes. A child that throws out of the renderer
or does not finish is recorded as `crash`, whatever the pictures would have
said, and in an application either is its end or its freeze, for a document
it did not write. So it is run over other WPT directories for their crashes
alone (round 67), and over pages `fuzz.ts` makes by cutting up this suite's
tests — a span cut out or repeated, a token put in, a few hundred or
thousand nested elements — each its own reference (round 68), or, with
`--from`, other directories' tests, with the tokens today's documents are
made of (round 69):

```bash
npx tsx scripts/conformance/fuzz.ts wpt fuzz1 3000 1
npx tsx scripts/conformance/fuzz.ts wpt fuzz4 3000 4 --from css/css-grid,css/css-text
npx tsx scripts/conformance/run.ts wpt fuzz1 --chunk 50 --timeout 60000
```

## Results

| round  | what it was                                        | X11         | Cocoa       |
| ------ | -------------------------------------------------- | ----------- | ----------- |
| before | `<Html>` as it shipped                             | 1,831 (31%) |             |
| 1      | the first nine fixes below                         | 2,417 (41%) | 2,212 (38%) |
| 2      | generated content, and what it brought to light    | 2,822 (48%) | 2,557 (43%) |
| 3      | the inline box model, and what it brought to light | 3,180 (54%) | 2,831 (48%) |
| 4      | anonymous boxes and tables, CSS syntax, baselines  | 3,713 (63%) | 3,329 (56%) |
| 5      | first letters, tables, clipping, positioning       | 4,733 (80%) | 4,321 (73%) |
| perf   | a paragraph's inline boxes in its one layout       | 4,739 (80%) | 4,325 (73%) |
| 6      | fixed tables, negative z-index, absolute margins   | 4,960 (84%) | 4,526 (77%) |
| 7      | margins through empty blocks, and their floats     | 4,982 (85%) | 4,545 (77%) |
| 8      | stylesheet encodings, clips, replaced sizes        | 5,042 (86%) | 4,606 (78%) |
| 9      | table baselines and backgrounds, media, sizes      | 5,073 (86%) | 4,637 (79%) |
| 10     | paint order, propagated decorations                | 5,100 (87%) | 4,660 (79%) |
| 11     | floats beside tall boxes, table widths, clearance  | 5,125 (87%) | 4,685 (79%) |
| 12     | fixed backgrounds, floats in inline boxes          | 5,145 (87%) | 4,705 (80%) |
| 13     | SVG, replaced sizes, objects                       | 5,219 (89%) | 4,779 (81%) |
| 14     | columns' widths and images                         | 5,241 (89%) | 4,800 (81%) |
| 15     | a block in an inline box, right to left            | 5,299 (90%) | 4,854 (82%) |
| 16     | url(), font-family, tables that clip               | 5,317 (90%) | 4,869 (83%) |
| 17     | HTML's alignment and body attributes               | 5,322 (90%) | 4,874 (83%) |
| 18     | `::first-line`, a pseudo-element's place           | 5,343 (91%) | 4,895 (83%) |
| 19     | CSS Color 4, CSS syntax, the body's inheritance    | 5,366 (91%) | 4,918 (83%) |
| 20     | `calc()`, `min()`, `max()`, `clamp()`              | 5,370 (91%) | 4,922 (84%) |
| 21     | custom properties, `var()`                         | 5,370 (91%) | 4,922 (84%) |
| perf   | a link or a column no longer stretches its bounds  | 5,372 (91%) | 4,924 (84%) |
| 23     | relative inline boxes, hidden inline text          | 5,381 (91%) | 4,929 (84%) |
| 24     | `vertical-align` on text                           | 5,404 (92%) | 4,930 (84%) |
| 25     | what is in the head, negative inline margins       | 5,415 (92%) | 4,938 (84%) |
| 26     | images in generated content                        | 5,419 (92%) | 4,942 (84%) |
| 27     | `unicode-bidi`                                     | 5,432 (92%) | 4,956 (84%) |
| 28     | `white-space` on an element                        | 5,436 (92%) | 4,959 (84%) |
| 29     | an inline box's line height, cleared empty blocks  | 5,443 (92%) | 4,962 (84%) |
| 30     | margins beside floats, `flow-root`, `min-height`   | 5,450 (92%) | 4,969 (84%) |
| 31     | a box's edges on the pixel grid                    | 5,460 (93%) | 4,971 (84%) |
| 32     | the newline after `<pre>`, pseudo-class arguments  | 5,460 (93%) | 4,972 (84%) |
| 33     | logical properties, `inset`, a corner's radius     | 5,460 (93%) | 4,972 (84%) |
| 34     | cascade layers                                     | 5,460 (93%) | 4,972 (84%) |
| 35     | nested rules, media ranges                         | 5,461 (93%) | 4,973 (84%) |
| 36     | flex items' sizes and auto margins                 | 5,461 (93%) | 4,973 (84%) |
| 37     | grid                                               | 5,461 (93%) | 4,973 (84%) |
| 38     | rounded borders                                    | 5,461 (93%) | 4,973 (84%) |
| 39     | linear gradients; WPT's fuzzy rule                 | 5,460 (93%) | 4,972 (84%) |
| 40     | percentage and elliptical radii                    | 5,460 (93%) | 4,972 (84%) |
| 41     | box shadows                                        | 5,460 (93%) | 4,972 (84%) |
| 42     | aspect-ratio, object-fit, a flex box's height      | 5,460 (93%) | 4,972 (84%) |
| 43     | line-clamp, text-overflow                          | 5,460 (93%) | 4,972 (84%) |
| 44     | 3D border styles                                   | 5,462 (93%) | 4,974 (84%) |
| 45     | a flex row measured for its content                | 5,462 (93%) | 4,974 (84%) |
| 46     | a table in an aligned cell                         | 5,462 (93%) | 4,974 (84%) |
| 47     | details, and markers inside                        | 5,466 (93%) | 4,978 (84%) |
| 48     | justify, and text that does not wrap aligned       | 5,470 (93%) | 4,978 (84%) |
| 49     | an ellipsis on every line                          | 5,470 (93%) | 4,978 (84%) |
| 50     | tab stops                                          | 5,471 (93%) | 4,979 (84%) |
| 51     | OpenType features                                  | 5,471 (93%) | 4,979 (84%) |
| 52     | text shadows                                       | 5,471 (93%) | 4,979 (84%) |
| 53     | a raised box's own line height                     | 5,471 (93%) | 4,979 (84%) |
| 54     | `::marker`                                         | 5,471 (93%) | 4,979 (84%) |
| 55     | an underline's offset and thickness                | 5,471 (93%) | 4,979 (84%) |
| 56     | `background-size`                                  | 5,471 (93%) | 4,979 (84%) |
| 57     | background layers                                  | 5,472 (93%) | 4,979 (84%) |
| 58     | intrinsic sizes                                    | 5,472 (93%) | 4,979 (84%) |
| 59     | `text-wrap`                                        | 5,472 (93%) | 4,979 (84%) |
| 60     | `translate`                                        | 5,472 (93%) | 4,979 (84%) |
| 61     | the room a shrink-to-fit box has                   | 5,472 (93%) | 4,979 (84%) |
| 62     | backgrounds painted through text                   | 5,472 (93%) | 4,979 (84%) |
| 63     | `display: contents`                                | 5,472 (93%) | 4,984 (84%) |
| 64     | outlines                                           | 5,472 (93%) | 4,984 (84%) |
| 65     | `list-style-image`                                 | 5,476 (93%) | 4,988 (84%) |
| 66     | a float on the line it is met on                   | 5,479 (93%) | 4,990 (84%) |
| 67     | gradients and shadows far off the window           | 5,479 (93%) | 4,990 (84%) |
| 68     | nested boxes, fuzzed pages                         | 5,479 (93%) | 4,990 (84%) |
| 69     | nested grids, floats no higher than the last       | 5,482 (93%) | 4,993 (84%) |
| 70     | floats side by side in a content width             | 5,485 (93%) | 4,995 (84%) |
| 71     | tables in tables, boxes clipped to nothing         | 5,485 (93%) | 4,995 (84%) |
| 72     | the list-item counter, CSS Lists 3 scopes          | 5,484 (93%) | 4,992 (84%) |
| 73     | flex items no smaller than their content           | 5,484 (93%) | 4,992 (84%) |
| 74     | percentages of a stretched or flexed item's height | 5,484 (93%) | 4,992 (84%) |
| 75     | the font's own `ch`, floats in unbroken text       | 5,486 (93%) | 4,994 (84%) |
| 76     | a word too long for its line kept whole            | 5,520 (93%) | 4,994 (84%) |
| 77     | `visibility: collapse` in tables                   | 5,525 (93%) | 4,999 (84%) |
| 78     | the generic `monospace` at its smaller size        | 5,531 (93%) | 5,005 (84%) |
| 79     | white space in a table's anonymous cells           | 5,536 (93%) | 5,010 (84%) |
| 80     | a spanning cell's width, and a percentage's        | 5,537 (93%) | 5,011 (84%) |
| 81     | collapsed borders at corners and at the sides      | 5,539 (93%) | 5,012 (84%) |
| 82     | `empty-cells: hide`                                | 5,540 (93%) | 5,013 (84%) |
| 83     | a collapsed border on a half-pixel grid line       | 5,541 (93%) | 5,013 (84%) |
| 84     | an image told to be a table's part                 | 5,542 (93%) | 5,014 (84%) |
| 85     | a cell's content in a height of its own            | 5,544 (93%) | 5,015 (84%) |
| 86     | XHTML style sheets as XML reads them               | 5,548 (93%) | 5,019 (84%) |
| 87     | a document's language, and attribute selectors     | 5,550 (93%) | 5,021 (84%) |
| 88     | a `<q>` in quotation marks                         | 5,550 (93%) | 5,021 (84%) |
| 89     | an absolute box a `max-width` holds, centred       | 5,554 (93%) | 5,025 (84%) |
| 90     | an image set `middle`, and `capitalize`            | 5,566 (94%) | 5,038 (85%) |
| 91     | a table cell's sizes, and `text-decoration`        | 5,575 (95%) | 5,047 (86%) |
| 92     | a top-aligned box's background, and `font`         | 5,588 (95%) | 5,051 (86%) |
| 93     | where an absolute box in a line would have been    | 5,595 (95%) | 5,058 (86%) |
| 94     | positioned boxes in their stacking context         | 5,600 (95%) | 5,063 (86%) |
| 95     | clearance, empty inline boxes and `initial`        | 5,609 (95%) | 5,073 (86%) |
| 96     | float rules 3 and 7, a canvas, a table's height    | 5,615 (95%) | 5,078 (86%) |
| 97     | a `top` line's baseline, collapsed borders, fields | 5,625 (95%) | 5,085 (86%) |
| 98     | margins of both signs, clearance, floats, columns  | 5,643 (95%) | 5,100 (86%) |
| 99     | `text-align-last`, family names, line heights      | 5,646 (95%) | 5,102 (86%) |
| 100    | ntk 8.14.1: kerning off, a family list's fallback  | 5,649 (95%) | 5,102 (86%) |
| 101    | `line-clamp` through a flow, `lh`, `-webkit-box`   | 5,649 (95%) | 5,102 (86%) |
| 102    | `fit-content()`, a content's intrinsic sizes       | 5,649 (95%) | 5,102 (86%) |
| 103    | ntk 8.14.2: a word shaped across elements          | 5,651 (95%) | 5,102 (86%) |
| 104    | flex `order` and baselines, inherited flex styles  | 5,651 (95%) | 5,102 (86%) |
| 105    | a flex item's `z-index`, painting in `order`       | 5,651 (95%) | 5,102 (86%) |
| 106    | a flex box's background with the flow's            | 5,651 (95%) | 5,102 (86%) |
| 107    | `justify-content`'s start, end, left and right     | 5,651 (95%) | 5,102 (86%) |
| 108    | a replaced flex item's size, `flex-basis: content` | 5,651 (95%) | 5,102 (86%) |
| 109    | absolute boxes in grids, `grid-template`, `grid`   | 5,651 (95%) | 5,102 (86%) |
| 110    | the grid track sizing algorithm, content alignment | 5,651 (95%) | 5,102 (86%) |
| 111    | grid areas and line names, `grid-auto-flow`        | 5,651 (95%) | 5,102 (86%) |
| 112    | `object-fit`, `object-position`, posters, embeds   | 5,651 (95%) | 5,102 (86%) |
| 113    | counter styles and `@counter-style`                | 5,651 (95%) | 5,102 (86%) |
| 114    | `aspect-ratio` both ways, `overflow: clip`, `body` | 5,652 (95%) | 5,103 (86%) |
| 115    | grid items with ratios, `auto-fit`, `%` gaps       | 5,652 (95%) | 5,103 (86%) |
| 116    | `stretch` and `-webkit-fill-available`             | 5,652 (95%) | 5,103 (86%) |
| 117    | containment and `content-visibility`               | 5,652 (95%) | 5,103 (86%) |

Of 5,895 reftests run through round 2 and 5,894 since, where a test that
depends on an `onload` handler is counted a script. As it shipped, `<Html>`
hung on 91 of them and threw from paint on one; no round since has done
either. The hangs were the renderer looping for ever inside a render, which
freezes an application whole; they are the first finding, and the most
important one. Round 3's Cocoa number is on react-x11 2.22.8 and
@windowkit/appkit 0.15.0, where master itself passed 2,454, not round 2's
2,557 — see round 3's third item for the hundred tests between them — and
round 4's and round 5's on ntk 8.12.10 and appkit 0.15.1.

By area, sorted by the number of tests:

| area                 | before, X11   | round 4, X11  | round 4, Cocoa | round 5, X11  | round 5, Cocoa |
| -------------------- | ------------- | ------------- | -------------- | ------------- | -------------- |
| normal-flow          | 217/694 (31%) | 534/694 (77%) | 506/694 (73%)  | 579/694 (83%) | 554/694 (80%)  |
| margin-padding-clear | 369/682 (54%) | 547/682 (80%) | 521/682 (76%)  | 648/682 (95%) | 618/682 (91%)  |
| positioning          | 129/513 (25%) | 299/513 (58%) | 288/513 (56%)  | 432/513 (84%) | 419/513 (82%)  |
| borders              | 255/504 (51%) | 378/504 (75%) | 376/504 (75%)  | 497/504 (99%) | 495/504 (98%)  |
| selectors            | 62/468 (13%)  | 77/468 (16%)  | 77/468 (16%)   | 438/468 (94%) | 437/468 (93%)  |
| text                 | 186/381 (49%) | 280/380 (74%) | 252/380 (66%)  | 290/380 (76%) | 258/380 (68%)  |
| backgrounds          | 114/336 (34%) | 238/336 (71%) | 172/336 (51%)  | 285/336 (85%) | 211/336 (63%)  |
| syntax               | 147/275 (53%) | 206/275 (75%) | 206/275 (75%)  | 206/275 (75%) | 206/275 (75%)  |
| tables               | 12/250 (5%)   | 52/250 (21%)  | 51/250 (20%)   | 92/250 (37%)  | 91/250 (36%)   |
| floats-clear         | 13/211 (6%)   | 130/211 (62%) | 108/211 (51%)  | 141/211 (67%) | 118/211 (56%)  |
| generated-content    | 17/205 (8%)   | 163/205 (80%) | 164/205 (80%)  | 174/205 (85%) | 174/205 (85%)  |
| linebox              | 41/191 (21%)  | 130/191 (68%) | 31/191 (16%)   | 138/191 (72%) | 34/191 (18%)   |
| css1                 | 18/164 (11%)  | 99/164 (60%)  | 53/164 (32%)   | 116/164 (71%) | 64/164 (39%)   |
| fonts                | 45/159 (28%)  | 120/159 (75%) | 116/159 (73%)  | 129/159 (81%) | 124/159 (78%)  |
| lists                | 12/155 (8%)   | 95/155 (61%)  | 95/155 (61%)   | 105/155 (68%) | 105/155 (68%)  |
| bidi-text            | 4/105 (4%)    | 62/105 (59%)  | 24/105 (23%)   | 65/105 (62%)  | 26/105 (25%)   |
| floats               | 17/100 (17%)  | 32/100 (32%)  | 32/100 (32%)   | 46/100 (46%)  | 46/100 (46%)   |
| box-display          | 17/86 (20%)   | 47/86 (55%)   | 39/86 (45%)    | 56/86 (65%)   | 55/86 (64%)    |
| ui                   | 39/52 (75%)   | 43/52 (83%)   | 37/52 (71%)    | 45/52 (87%)   | 37/52 (71%)    |
| visufx               | 3/49 (6%)     | 3/49 (6%)     | 3/49 (6%)      | 47/49 (96%)   | 47/49 (96%)    |
| pagination           | 38/43 (88%)   | 41/43 (95%)   | 41/43 (95%)    | 41/43 (95%)   | 41/43 (95%)    |
| visudet              | 6/37 (16%)    | 16/37 (43%)   | 17/37 (46%)    | 20/37 (54%)   | 21/37 (57%)    |
| cascade              | 12/32 (38%)   | 23/32 (72%)   | 23/32 (72%)    | 24/32 (75%)   | 24/32 (75%)    |
| zindex               | 13/29 (45%)   | 14/29 (48%)   | 14/29 (48%)    | 22/29 (76%)   | 22/29 (76%)    |
| visuren              | 4/26 (15%)    | 11/26 (42%)   | 8/26 (31%)     | 12/26 (46%)   | 9/26 (35%)     |
| abspos               | 3/25 (12%)    | 12/25 (48%)   | 12/25 (48%)    | 16/25 (64%)   | 16/25 (64%)    |
| values               | 8/25 (32%)    | 11/25 (44%)   | 7/25 (28%)     | 17/25 (68%)   | 11/25 (44%)    |
| sec5                 | 11/23 (48%)   | 22/23 (96%)   | 22/23 (96%)    | 22/23 (96%)   | 22/23 (96%)    |
| colors               | 2/19 (11%)    | 8/19 (42%)    | 14/19 (74%)    | 9/19 (47%)    | 15/19 (79%)    |
| media                | 10/17 (59%)   | 10/17 (59%)   | 10/17 (59%)    | 10/17 (59%)   | 10/17 (59%)    |

Paged media passes because neither a test nor its reference paginates here;
those tests measure nothing about `<Html>`, which has no pages.

## What the suite found, and what was fixed

Nine defects, each fixed with a test that fails without the fix:

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
9. **The `font` shorthand kept what it did not name.** CSS 2.1 15.8 resets
   every part a shorthand leaves out, and only the named parts were applied:
   `p { font: 12pt serif }` inside a document at `20px/1em` kept 20px lines,
   and a bold parent's weight survived it. `font: inherit` also took the
   line height without its unit. Found on Cocoa only, once the engine fix
   below moved its baselines; see [Lessons](#lessons).

And upstream, found the same way:

- **A scaled image faded out over its outer pixels** in ntk, because the
  server-side bilinear filter sampled past its edge as transparent. Fixed in
  ntk 8.12.9 (ntk #392) by clamping to the edge, as the canvas spec and
  browsers do; every reference built from image swatches differed from its
  test by their rims.
- **CoreText put all of a line's leading under its glyphs**, where ntk
  splits it evenly above and below them, as CSS does, so on a line taller or
  shorter than its glyphs `<Html>` drew them up to half a glyph from where
  X11 did. Fixed in @windowkit/appkit 0.15.0 (windowkit/appkit#80), which
  lands with react-x11#709: react-x11's `<text>` had been making up for the
  old placement with a shift of its own, which on ntk moved its glyphs a
  quarter of the leading too far down.

### Round 2

Generated content, and what building it brought to light:

10. **`::before` and `::after` generated nothing**: a rule for one failed to
    compile and dropped out of the cascade. They are boxes of their own
    `display` now, holding strings, `attr()`, counters and quotes, with
    `counter-reset` and `counter-increment` scoped as CSS 2.1 12.4.1 has it,
    and CSS 2's single-colon `:before` counted as the type it is rather than
    a class. Generated content went from 17 to 130 of 205, lists from 12 to
    75 of 155 — the suite numbers its list tests with counters — and a
    column's content is not rendered, as 17.2.1 says.
11. **White space collapsed text node by text node**, where CSS collapses it
    across the line (16.6.1): every `<p>` followed by a newline began with a
    space, `Hi<b> </b>there` lost its space, `Hi <b> there</b>` kept two, and
    a line after a `<br>` began with one. Text across the suite moved by
    that space; css1 went from 22 to 70 of 164.
12. **`font-size: 0` was 1px**, so the spaces between inline-blocks in a
    row set at no size took a pixel each — the usual way to set columns
    inline — and a 100% row wrapped. Fonts went from 46 to 86 of 159.
13. **A line took its edges from the formatting context**, not its block:
    a block wider than the body it sits in had its lines cut to the body.
14. **A word with no room beside a float was cut to the room**, where CSS
    moves the line below the float (9.5); an inline-block the same.

Four tests that passed in round 1 fail now, each for a reason recorded here
rather than hidden: `inlines-016` passed because a stray space stood in for
an inline box's horizontal padding, which `<Html>` does not draw;
`floats-placement-vertical-004` has a float after text on its line, and
`<Html>` places a formatting context's floats before its lines, as though
the float came first; `content-counter-001`'s reference is `about:blank`,
so it passed only while generated content drew nothing; and
`content-attr-case-002` is XHTML, whose attribute names are case-sensitive
where the runner reads it as HTML.

### Round 3

The inline box model, and what it brought to light:

15. **An inline element's padding, border and margin took no room**, and its
    background was painted run by run over its text alone. Its edges are on
    its line now — the start side before its first fragment, the end side
    after its last, on the side its `direction` puts them (8.6) — and its
    background and border are painted a fragment a line over its face's
    height and its vertical padding (10.6.1), rounded and bordered only where
    it starts and ends. That is the padded `<a>` HTML mail sets as a button,
    and `inlines-016` passes again on X11 — round 2's stray space had been
    standing in for exactly this padding.
16. **A line with an atomic on it was aligned piece by piece**: each piece of
    text was laid out with the paragraph's alignment, and whatever followed
    it was placed as though it had not been, so a centred line with an image
    in it came out with the text over the image. A right-to-left one was
    placed in logical order, its first word leftmost. A line is aligned whole
    now, in the room beside the floats over its full height, and put in
    visual order: the engine orders the text inside a piece, and the line
    orders the pieces (UAX #9's L2). `direction: rtl` tests went from 24% to
    56%.
17. **A block's background was painted again behind every run of its own
    text**, where the run took the text's style and the text's style was the
    block's: a block of zero height with a background showed it behind its
    text. X11 has done it since `<Html>` shipped. Cocoa started to when
    react-x11 2.22.8 gave CoreText's runs their spans, and that is the
    hundred tests master lost there between round 2 and this round's
    baseline — 96 of them come back with the inline painter, which paints an
    element's inline ancestors and never the block.
18. **Border widths**: the initial width was 0, where CSS has `medium`, which
    computes to nothing only while the style is `none` — so `border-style:
solid` alone drew no border; a negative width was clamped to 0, where CSS
    drops the declaration and the one before it stands; `-0`, `+0` and `0.0`
    were not read as zeros; and the `border` shorthand's `medium` was not
    scaled at 2x.
19. **`letter-spacing` and `word-spacing` were parsed and never drawn.** Both
    engines space a run's letters; word spacing is that, on the space runs a
    word-spaced text box is split into. Word spacing went from 51% to 87%.
20. **`inherit` reached only the inherited properties**: `border: inherit`,
    `margin: inherit` and `padding: inherit` did nothing.
21. **A line that ended at a `<br>` did not end** when the next thing on it
    was an element's edge or an atomic.
22. **`<iframe>`, `<video>` and `<embed>` were empty inline boxes**; they are
    boxes of their size now, 300×150 without attributes, with nothing in
    them, and a percentage height on an absolutely positioned box resolves
    against its containing block, which is known before the box is laid out.
23. **The runner rendered a test whose picture depends on an `onload`
    handler**; an event handler attribute is a script now, as `<script>` is.

Round 2's passes that fail now, 15 on X11 and 12 on Cocoa, are each recorded
rather than hidden:

- **Eight bidi tests** open an override (U+202E) on one side of a bordered
  or padded element and close it on the other. The engine is handed a line a
  piece at a time where an element has edges, so an embedding that crosses
  one is resolved on each side of it separately. They passed while neither
  the test nor the reference drew the element's border.
- **Three more, on X11 only**, space the letters of an overridden run: ntk
  puts a right-to-left run's letter spacing on the wrong side of its glyphs,
  or spaces the bidi controls themselves, and CoreText does neither.
- **`inherit-computed-001` and `border-color-012` ask for opposite things.**
  An element that inherits a border colour its parent left to `currentColor`
  draws it in its own colour in CSS Color 4 and browsers, and in its
  parent's in CSS 2.1. `<Html>` follows CSS Color 4.
- **`inline-replaced-height-005`** is a percentage height in flow, which
  `<Html>` takes as `auto`; it passed while the `<iframe>` was an empty
  inline.
- **`letter-spacing-080`** spaces its letters 6em and names
  `letter-spacing-007`'s reference, which is 96px: no renderer can pass it.
- **`word-spacing-characters-001`, on Cocoa**: a tab after an element with
  padding measures its stop from where the text resumes rather than from the
  line's start.

### Round 4

What reading round 3's losses found, and then what the failing tests that
use CSS's table displays had in common:

24. **An anonymous box took its parent's whole style.** The block the
    fix-up wraps text in beside a block — `<div>text<p>…</p></div>` — and
    the anonymous table parts it completes a table with shared their
    parent's style object, so they took its height, padding, borders,
    background, relative offset and opacity a second time. In a padded div
    the text sat twice the padding in, and the block after it the div's
    height further down. An anonymous box inherits what inherits and starts
    everything else from its initial value, as CSS 2.1 9.2.1.1 and 17.2.1
    have it. 127 tests pass for it on X11.
25. **A table column was taken for a stray child**, wrapped in a row and a
    cell of its own, and drawn as one: a table of one row had two. A
    column stays beside the rows now, laying out and painting nothing.
26. **A percentage height resolved only on an absolutely positioned box.**
    It resolves in any box whose height is set, a length or a percentage
    that itself resolved, through inline and anonymous boxes (10.5, #150).
    The document's root has no height to give — the element sizes to its
    content — so `html, body { height: 100% }`, which mail sets as often as
    not, stays as tall as what it holds rather than being cut to a window.

27. **Stylesheets were scanned for braces and semicolons by a helper per
    job**, each knowing strings, escapes and brackets a little differently.
    They are read a component value at a time now, as CSS Syntax reads
    them. Escapes resolve in property names and values, and a rule is filed
    under the name its selector means, so Tailwind's `.md\:flex` applies
    at last. A style rule runs to its block: a stray `;` no longer ends the
    sheet, and an `@` that names nothing no longer lets the rule after it
    through. A group with one invalid selector is dropped whole, an unknown
    pseudo-class included (4.1.7). `@import` counts only ahead of every
    other rule. A declaration list reads an at-rule to where it ends, and a
    value left with a `!` that is not `!important` is dropped. 44 tests,
    36 of them the syntax tests, and nothing lost.
28. **Table parts outside a table got no table around them.** A run of
    cells is one anonymous row in an anonymous table now, inline where
    their parent is inline (17.2.1), and a run of stray cells in a table
    shares one row rather than taking one each.
29. **Every atomic sat bottom-on-baseline.** An inline-block sits on its
    last line's baseline and an inline-table on its first row's (10.8.1),
    and a block inside that clips its overflow gives its bottom edge, as
    CSS Box Alignment has it. A button's label rode its descent above the
    text beside it.
30. **The initial `border-spacing` was 2px**, the HTML table's, where
    CSS's is 0: every anonymous table was spaced like a `<table>`. Items 28
    to 30 did nothing apart; together they are 340 tests, across every
    area that sets its content out with `display: table-cell`.
31. **ntk 8.12.10 and appkit 0.15.1** measure a no-break space a line ends
    on and space letters on the same side of every glyph: eight tests, and
    two lost — `white-space-processing-046` and `047`, whose preserved
    space under `white-space: pre` still hangs (#151); they passed while
    the engines dropped their references' no-break space too.

Sixteen tests that passed in round 3 fail after items 24 to 26, the same on
both backends:
twelve give a column or a column group a border, and two an outline, in a
table, and passed because the invented row drew the column's style as a
cell's. A column's borders count only where borders collapse (17.6.2),
which `<Html>` draws as separate borders with no spacing. The other two
cover an inline `<svg>` it does not draw with a box moved up over it, and
passed because the anonymous block around the `<svg>` took its parent's
300px height.

### Round 5

`::first-letter` first, as the largest thing still missing, and then
whatever the tests that failed had in common:

32. **`::first-letter`.** The first letter of a block's first line, with
    the punctuation before and after it, is a box of its own in the
    pseudo-element's style, inline or floated for a drop cap, inside
    whatever the letter is in (5.12.2). It is looked for through the
    block's inline content and its first child blocks, generated content
    included; a `<br>`, an image or an inline-block that starts the line
    means there is none. Punctuation in a text of its own before the
    letter, as `<q>` opens with, takes the style too. Of the 363 tests that
    use it 4 passed; all of them pass on X11 now, and 361 on macOS.
33. **An inline-block or an image on a line was painted twice**, by the
    line and by its parent's walk over its children. A solid fill hides
    it; text came out heavier at every antialiased edge, and a translucent
    background twice as opaque.
34. **An `<a>` with no `href` was drawn as a link.** It is an anchor.
35. **Borders collapse.** One border along each edge of a table's grid,
    centred on it, chosen from everything that meets there as 17.6.2.1
    chooses. They were drawn as the separate model with no spacing, every
    rule between two cells two borders wide. With it, four things every
    table had wrong: a middle-aligned cell moved its whole box down and
    let the table's background show above it; a caption was inside the
    table's border (it is outside now, by `caption-side`, and an auto table
    is at least as wide as its caption's longest word); a footer group
    was drawn where the markup put it; and a column group's columns were
    wrapped in a table of their own. 163 tests between them.
36. **`overflow` did not clip.** A box whose `overflow` is not `visible`
    clips what it holds to its padding box now, rounded where it is
    (11.1.1), but for a positioned box whose containing block is outside
    it; `clip: rect()` shows the part of an absolute box it names. HTML
    mail's preheader, hidden with `max-height: 0; overflow: hidden`, was
    drawn over the message. 49 tests, 44 of them `clip`'s.
37. **An absolute box with auto offsets went to its containing block's
    corner**, not to where the flow would have put it (10.3.7, 10.6.4), and
    it is measured from the containing block's padding edge rather than
    its content edge (10.1); a fixed box's containing block is the
    viewport. A relative box is painted among the positioned ones, in
    document order (Appendix E), where it was painted with the flow. Items
    37 and 38 are 156 tests.
38. **Right to left started at the left** three ways: a block of a set
    width sat at the left of a right-to-left containing block (10.3.3),
    `text-indent` indented the first line from the left (16.1), and an
    absolute box took the left edge for its static position.
39. **A box with a formatting context of its own ran under a float.** A
    table, a block that clips its overflow and a block-level image are
    rectangles beside the floats, or below them where they do not fit
    (9.5) — the image floated left with an `overflow: hidden` block of
    text beside it. An image set `display: block` is a block now; it was
    inline whatever its display.
40. **A list item's marker stayed where its item was laid out**: a list in
    a table cell drew its bullets at the document's corner. Items 39 and 40
    are 27 tests.
41. **Negative or `auto` padding was applied**; the declaration goes. A
    length in `ex` is the font's x-height, which is 0.8em for Ahem, where
    it was half an em. 118 tests.
42. **An empty block's margins did not collapse through it** (8.3.1). A
    last child's margin escapes its parent only where the parent's
    `min-height` does not set its height, and a table caption keeps its
    margins.
43. **The initial containing block was the document, not the viewport.**
    A percentage height on the root element and an absolute box with
    nothing positioned around it measure from the viewport (10.1), so
    `html, body { height: 100% }` is a window tall; the document is as
    tall as what overflows its root, so nothing is cut off. This replaces
    item 26's rule that the root has no height to give. Items 42 and 43
    are 58 tests.
44. **A `background-position` keyword did not say its axis**: a lone
    `bottom` put an image at the right (14.2.1). And **a table's height
    was not shared among its rows** (17.5.3), so a cell set at the bottom
    of a tall table sat at the top. 47 tests.

The runner changed once: references a test names side by side are
alternatives, as WPT's runner walks them, where it compared with the
first alone. Twelve tests name more than one, and one of them passes for
it — `numbers-units-015`, whose right rendering depends on the font's
x-height and which names a reference for each.

Two tests that passed in round 4 fail now on both backends, and passed by
accident. `zindex-affects-block-in-inline` puts a block in a relatively
positioned `<span>` with a `z-index`; it passed while relative boxes were
painted with the flow. `background-bg-pos-206` needs
`background-attachment: fixed`, which is not implemented; its reference's
absolute image sat at the bottom of the document with the test's image,
and sits at the bottom of the viewport now. On macOS four more fail until
windowkit/appkit#86: they measure a caption's narrowest width, and
CoreText gave a line one letter where not even that fitted, so the widest
letter was the answer. With it, macOS passes all four and two more.

The performance work after round 5 (the `perf` row) sets a paragraph's
padded inline boxes as spacers in its one layout, and lost two tests on
macOS. `content-height-005` needs web fonts, which are never fetched, and
passed by a difference that is gone. `rtl-span-only` is CoreText drawing
letter-spaced text that opens a line after a hard break one device pixel
left of where it reports it, which a `<span style="letter-spacing">` does
too: the reference sets its spans with spacers, and the test, right to
left, is set a piece at a time.

What is left falls in two kinds. **Features not built**: `::first-line`,
`table-layout: fixed` reading `<col>` widths (done in round 6), `background-attachment:
fixed`, the static position of an absolute box inside a line, bidi
embeddings across an element's edges (#149), `z-index` stacking beyond
one parent. **Near misses**: 194 of X11's failures differ by 200 pixels
or fewer. 69 of them are Ahem's box edges: at 16px its outline stands
12.8px above the baseline, the engines place glyphs on whole pixels and
draw the outline where it falls, so a square's top and bottom rows are
antialiased where a browser, hinting Ahem onto the pixel grid, draws them
solid. Light vertical hinting in ntk — snapping a face's alignment zones
to whole pixels, as FreeType's does — would answer them, and changes how
every glyph on X11 is drawn, so it is left for a decision.

### Round 6

The largest clusters of what was left, each traced to one rule:

45. **`table-layout: fixed` did not read `<col>`**, and took a first-row
    cell's content width for its column. A column's width sets it now,
    then a first-row cell's border box, shared over the columns it spans
    less the spacing between them; the rest share what remains, and a
    table narrower than its fixed columns widens to hold them
    (17.5.2.1). A fixed table with `width: auto` is laid out by its
    content, as the section says; an auto table's `min-width` widens its
    columns. `<col>` and `<colgroup>` backgrounds are painted under the
    cells that start in them (17.5.1), and `border-spacing` takes a
    second length, for the rows (17.6.1). With HTML's
    `table { box-sizing: border-box }`, a table's `width` includes its
    borders. 94 tests, 75 of them tables.
46. **A negative `z-index` was painted over the flow**, with the rest of
    the positioned boxes. It goes over its stacking context's background
    and under everything else in the context now (Appendix E), the root
    element being the root context. 35 tests on X11, 34 on macOS.
47. **Table cells in an inline box ran into the text after them.** The
    builder treated each as a block for white space, and dropped the space
    after the anonymous inline table they are wrapped in. 15 tests.
48. **An empty list item hung its marker an ascent too high**, from the
    top of its content, where a list item holding text sets it on its first
    line. It stands where that line would have been now. 41 tests, the
    `list-style-*-applies-to` ones, which put an empty list item in a
    table.
49. **An absolute box between two offsets kept `auto` margins of 0.** With
    `left`, `width` and `right` all set, the `auto` margins share what the
    three leave, and with none `auto` the end offset gives way (10.3.7,
    10.3.8); with `top` and `bottom` and no height, the box fills what they
    leave, and with a height its `auto` margins share the rest (10.6.4,
    10.6.5). 20 tests on X11, 16 on macOS.
50. **A line of images alone was as tall as the images.** Every line box
    starts with its block's strut, its face at its `line-height`
    (10.8.1), and the lines set a piece at a time left it out. With it, a
    list item with a marker and no line holds its marker's, as an empty
    `<li>` does in a browser, and an inline table of empty rows stands on
    its first. 22 tests on X11 and 16 on macOS, nine of them
    `background-position` on a table part.

Four tests that passed by accident fail on both backends now.
`margin-collapse-004` compares a bar in flow with one set at `z-index:
-1`, which now goes under the paragraph above it, where a browser puts it;
the one in flow is painted over that paragraph's text, because this
painter draws a block's text before the next block's background, where CSS
paints every block background of a stacking context first.
`background-intrinsic-001`, 002 and 004 cover an absolute box between four
offsets with an SVG background, which is not drawn; the box had no height,
and fills its offsets now. The strut costs two more:
`list-style-position-applies-to-008` matched a fallback reference with a
list item that is laid out, inside an inline box, as an inline block of
no width, where a browser gives it the line; and `floats-placement-006`
places a cleared float that follows an inline-block under that line, now
3px taller for the strut, which then avoids it, since the floats in a
line's content are placed before its lines rather than where the line has
got to.

### Round 7

51. **A margin stopped at an empty block.** An empty block's own two
    margins collapsed, and the margins either side of it with them, but the
    walk that collapses a block's top margin with its first child's stopped
    there. A `<div>` holding only an absolute image, before a paragraph,
    left the paragraph a body's margin lower than a browser does, since
    through the empty block the body's margin and the paragraph's are one
    (8.3.1). The walk goes on past an empty child now, to its bottom margin
    and the next child's top. It runs before anything is laid out, so it
    decides "empty" from styles and children, and says no wherever layout
    might say otherwise: an inline box with an edge, a percentage, text
    that is kept. An empty inline box makes no line (9.4.2), so a block
    holding one is as empty. 18 tests on X11 and 15 on macOS, the
    `clear-applies-to` group's reference among them.
52. **A new formatting context after such a block pushed its float down.**
    A float in an empty block is placed where the margin collapsing through
    the block ends, so the margin carries it; a box with a formatting
    context of its own after it must not overlap it (9.5). Where the box
    fits beside the float, both move with the margin; where it does not,
    the box separates from the float as clearance would, and sits under it.
    The walk tells the two apart from the widths the styles state, and
    takes a box of `width: auto` to fit, since there it shrinks to the room
    it has. 4 tests on X11 and 3 on macOS, the `new-fc-*` ones.

Neither round-7 fix lost a test. The walk's answer was checked against
layout's over both suites, with a throw wherever layout found a block the
walk had called empty holding something; none did.

### Round 8

53. **A stylesheet was text the host had to decode.** A host that fetches
    a stylesheet has bytes and, often, the charset its protocol named, and
    CSS says which encoding the bytes are in (CSS 2.1 4.4, CSS Syntax 3
    3.2). `onResource` may hand the bytes over now, with that charset. A
    byte order mark decides first, then the charset handed over, then an
    `@charset` at the very start of the bytes, then the referrer: a
    `<link charset>`, then the document's encoding, which is the new
    `charset` prop, or, for an `@import`, the encoding of the sheet
    importing it. Then UTF-8. 44 tests on both backends, the
    `at-charset-*` and `character-encoding-*` ones.
54. **An imported stylesheet's rules came after its importer's.** An
    `@import` stands where it is written, so the sheet importing it wins a
    tie (6.4.1). The import was numbered after its importer, and won. 2
    tests.
55. **An `overflow` clip showed a row more than its box's background.** A
    background at a fractional position rounds to the nearest pixel, and
    the clip was rounded out to whole pixels, so a row of what it clips
    showed beyond the background's edge. The clip is the background's
    pixels inside the borders now. A 2x display turns it up most: 5 tests
    on X11 and 6 on macOS, among them the last `new-fc-*` one round 7 left
    on macOS.
56. **A form control or a frame took its image's ratio.** Only an image
    has an intrinsic ratio (10.3.2); a control's size and a frame's 300 by
    150 are defaults. Kept as ratios, a text field set to `width: 100%`
    came out twice its height, a button with a width a square taller than
    its text, and an `<iframe>` with only a height half its width. 9 tests.

Round 8 lost none.

### Round 9

57. **A table cell aligned on the baseline was placed at the top.** Its
    first line, at any depth, sits on its first row's baseline now, the
    lowest of the row's cells', and the row grows to hold the cells hung
    from it (17.5.3). An empty cell gives the row no baseline, as in a
    browser, or a cell given a height and nothing in it would hang the row
    from its bottom. 7 tests.
58. **A cell did not take its row's `vertical-align`.** HTML's rendering
    rules put `middle` on the rows and have the cells inherit it; the UA
    sheet gave the cells `middle` themselves, so `<tr valign="top">`, all
    over mail, left its cells in the middle. No test in this suite covers
    it.
59. **A negative size was taken.** A negative `width`, `height` or
    minimum or maximum of either is illegal and drops the declaration
    (10.2–10.7); `max-height: -1px` made a box an inch tall no height. 11
    tests.
60. **Only `print` and `speech` were other media.** `braille`, `embossed`,
    `handheld`, `projection`, `tty` and `tv` do not match here either, and
    an `@import`'s media list is read. 8 tests.
61. **A row painted its background over its whole box, and its borders.**
    A row or a row group paints its background in its cells' areas, so
    the spacing between cells shows the table and a row group with no
    cells shows nothing (17.5.1); its borders are the collapsed grid's or
    none (17.6.1). 5 tests.

Round 9 lost none. Two clusters it looked at are not layout, and are left:

- **`vertical-align` on text.** A raised `<span>` or a `sub` needs its runs
  set off the line's baseline, and the line box to grow to hold them. The
  text engines lay a paragraph out as one layout with one baseline a line,
  and none of them takes a shift per run: it needs a seam in ntk, in
  appkit and in core. About 25 tests.
- **The monospace size.** A browser sets `font-family: monospace` at 13px
  where the rest is 16px, a user-agent quirk that makes `<code>` smaller
  than the text around it. The runner gives every family one size, so the
  tests built on it wrap where a browser's do not. 12 tests.

### Round 10

62. **A flow was painted a block at a time.** CSS paints a stacking
    context's in-flow block backgrounds and borders first, then its floats,
    then the lines of them all, then its positioned boxes (Appendix E). A
    float was covered by the background of every block after it, so the
    shaded paragraph beside a floated image hid the image, and a block's
    text by the next one's background where a negative margin overlapped
    them. The painter makes those passes now. A child that is no plain block
    of the flow — a table, a flex box, a box that clips, a replaced element
    — is still painted whole, in the last pass among the lines: it stands
    beside the floats rather than under them, and its text is over every
    block background like the lines'. 21 tests on X11 and 16 on macOS.
63. **A text decoration stayed on its element.** An underline or a line
    through is propagated to an element's in-flow descendants and drawn in
    the colour of the element that set it (16.3.1): an underlined link's
    `<strong>`, an `<em>` inside a `<u>`, the cells of an underlined table.
    Not a float, an absolute box or the inside of an inline block, and
    `text-decoration: none` takes none away. 7 tests.
64. **An underline was drawn over its text.** It goes under the glyphs and a
    line through over them (Appendix E), so a descender crosses its own
    underline. The decoration one element propagates in its colour showed
    through another's text in another colour: the one test item 63 would
    otherwise have lost.
65. **White space between a table's parts made a cell.** Under
    `white-space: pre` the line breaks between rows were kept, and each
    became a cell before its row; rule 1 of 17.2.1 drops them whatever
    `white-space` says. The six tests it covers draw Ahem glyphs, and are
    near misses now rather than a row out.

Round 10 lost one test, `margin-collapse-037`, by 25 pixels of
antialiasing: the reference's paragraph now paints its descenders over
the green block after it, as CSS orders it, where the test's green is an
absolute box over them.

One more gap found, for the upstream list beside `vertical-align` on text:

- **A word wider than its line is broken.** CSS lets an unbreakable word
  overflow its box (`overflow-wrap: normal`), and every text engine here
  breaks it at a grapheme instead — ntk's `_forceBreak`, CoreText's and
  DirectWrite's line breakers alike. None takes an option not to. 30
  tests, and a long URL in a narrow mail column.

### Round 11

66. **A box with a formatting context of its own ran into a float lower
    down.** A table, a block that clips or a block-level image must not
    overlap any float in its formatting context (9.5), and the room beside
    the floats was taken at its top edge alone. It is taken over the box's
    whole height now, known once it is laid out, and a box that runs into
    a float lower down is laid out again in what is left. 10 tests.
67. **A table with a width of its own left most of it empty.** What a set
    width has beyond the columns' content goes to the columns (17.5.2.2):
    those not set to a width take it in proportion to their content, or
    all of them where every one is set. The columns kept their content's
    width, so a header or a row of buttons in a mail's 600-pixel table
    stood narrow at its left. 8 tests.
68. **An inline-block ran into a float beside its lower part.** A line
    box must not run into a float, and an inline-block makes its line as
    tall as itself; the room was taken for a line of text. 4 tests.
69. **A margin after an empty block with clearance escaped its parent.**
    The cleared block's own margins go into its clearance, and the margins
    of the empty blocks after it that collapse with it stay in the parent
    rather than collapse through its bottom (8.3.1, 10.6.3). 3 tests.

Round 11 lost none.

### Round 12

70. **`background-attachment` was dropped**, in its longhand and in the
    `background` shorthand. A `fixed` image is positioned against the
    viewport rather than its element, and painted only in its box
    (14.2.1). 11 tests.
71. **A float or an absolute box inside an inline box was never laid
    out.** An inline box lays out nothing of its own, so what is out of
    flow inside it is the paragraph's; the block's walk met only its own
    children, and a float in a padded `<span>` or a badge set `absolute`
    in a link stood at the page's corner with no size. 5 tests.
72. **A table was clamped to its room, or held at its cells' set widths.**
    A table of `width: auto` is never narrower than its content asks, and
    a width a cell was set to gives way first (17.5.2.2). Clamped, a table
    whose words did not fit beside a float ran under it; held at its cells'
    widths, a table went below floats it could have sat beside. 4 tests.

Round 12 lost none. Of what fails on both backends, 19 more tests are the
engines breaking a word wider than its line (the upstream list, above):
an inline-block of `12345678` capped at `max-width: 4em` is two lines
where CSS has it one, overflowing.

### Round 13

73. **SVG was not drawn.** An inline `<svg>` was an unknown inline element
    whose children made no boxes, and SVG bytes failed the image decoder,
    so a drawing, an SVG image and an SVG background left a hole or
    nothing. They are drawn by ntk's `SvgView` now, with CSS's part of it
    here: the intrinsic width, height and ratio a box is sized by, the
    `viewBox` fitted as `preserveAspectRatio` says, the clip, and the
    percentages of the viewport, which `SvgView` reads as numbers. XHTML's
    `<svg:svg>` counts where its prefix is bound to SVG, and a type
    selector sees it as `svg`. 65 tests, 44 of them the sizing of a
    replaced element with an SVG as the element.
74. **A limit on one axis of an image left the other where it was.** An
    image under `max-width: 100%` in a narrow column was squashed rather
    than scaled. The height follows the width that was used now, and an
    image sized by its ratio alone meets its limits by 10.4's table. An
    `hr` took its intrinsic width, which it has none of, so every rule in a
    document drew nothing. 5 tests.
75. **An `<object>` showed its fallback content always.** Where its `data`
    is an image, it is that image now. 4 tests.

Round 13 lost none. Two more gaps found, for the upstream list:

- **ntk has no hinting.** 68 tests fail on both backends by one row of
  pixels. Ahem at 16px has a 12.8px ascent, so a square's top edge lands a
  fifth of a pixel off the grid and is antialiased, where the reference's
  box is not. Browsers on Linux pass them because FreeType hints the edge
  onto the grid; CoreText does not hint either.
- **`SvgView` reads a percentage as a number.** A `width="100%"` in a
  drawing was a hundred user units. `<Html>` resolves them against the
  viewport before it hands the tree over, and core's own `<svg>` element
  still draws them wrong.

### Round 14

76. **A column's width was read in a fixed table only.** In an auto table
    a column's `width` counts as its cells' do, and a column group's is
    spread over its columns where theirs come to less (CSS 2.1 17.5.2.2);
    each within its `min-width` and `max-width`, and a group with no columns
    of its own is one. A table of empty cells laid out by its `<col>` widths
    was no width at all. 6 tests on X11 and 5 on macOS.
77. **A column's background image was not drawn**, as a column is laid out
    nowhere. Its box is the one its cells make now (17.5.1), and the image
    is placed there. Where borders are separate a row's box runs from its
    first cell to its last, without the spacing either side that its
    laid-out box holds, and its image is placed against that. 16 tests.

Round 14 lost none.

### Round 15

78. **A block in an inline box was laid out as an inline-block.** CSS 2.1
    9.2.1.1 breaks the inline box around it: the pieces before and after
    are inline boxes of their own, without an edge where the block cut
    them, and the block stands between them. `<font>` around paragraphs,
    as old mail writes it, set them side by side at their words' widths,
    and a link around a card's blocks put them in a line. 53 tests on X11
    and 51 on macOS, and one lost: `white-space-processing-048` passed
    while a span holding a float was laid out as an inline-block, and fails
    now by the edge of an Ahem glyph at 16px, with the 68 above.
79. **Right to left.** HTML's `dir` was not read, so a document marked
    `dir="rtl"` was laid out left to right; a table right to left had its
    first column at the left (17.2); and a relative box with both `left`
    and `right` set moved by its `left`, where right to left it is its
    `right` that wins (9.4.3). 6 tests on X11 and 4 on macOS.

### Round 16

80. **`url()` was read by a pattern, not as a token** (CSS Syntax 3
    4.3.6). `url(a/*b)` started a comment that ran on through the rest of
    the sheet, `url(a\ b)` kept its backslash, a url the end of the sheet
    cut off was no url, and a bad one — white space or a quote inside it,
    or anything after it — was used where it makes its declaration
    invalid. The `background` shorthand is read whole before it sets
    anything, so an invalid one no longer half applies. 4 tests.
81. **A `font-family` with a name that is none was kept.** A name is a
    string or identifiers (15.3): `test!foo, Ahem` set Ahem, where the
    declaration is dropped. 8 tests on X11 and 6 on macOS.
82. **A table did not clip.** `overflow` applies to the table box, not to
    the wrapper with its captions (the errata to 11.1.1). 6 tests on X11
    and 5 on macOS.

Round 16 lost none.

### Round 17

The suite hardly uses HTML's presentational attributes, and mail is written
in them, so this round was checked against mail's patterns as much as
against the suite.

83. **HTML's `align` was read as `text-align` everywhere.** A table's
    places the table — `center` gives it auto margins, `left` and `right`
    float it — so `<table align="center" width="600">`, the frame of nearly
    every mail, stood at the left with its cells' text centred. `<center>`,
    and `align` on a div, a cell, a row or a row group, align the blocks in
    them as well as their text (HTML's rendering, "align descendants"), as
    browsers' `text-align: -webkit-center` does, which is read too. A table
    with auto margins and no width was placed before it shrank to its
    columns and stayed at the left: a mail's centred button.
84. **`<body text link>` and the `background` attribute were not read.**
    1 test, `content-145`.
85. **Nor were a cell's `nowrap`, a `<br>`'s `clear`, an image's `align`
    in its line, or a rule's `color`, `size` and `align`.** A `<br>` that
    clears is an empty block that clears, which the inline content around
    it is broken for, as for any block in an inline box — so CSS's `clear`
    on a `<br>` works too: 4 tests. A rule narrower than its line is
    centred, as browsers centre one.

Round 17 lost none.

### Round 18

86. **A pseudo-element in the middle of a selector was accepted.** A
    pseudo-element is the last thing in its selector (CSS 2.1 5.10), so
    `p:first-line p`, `p:first-line[id]` and `p:first-line+p` are not
    selectors, and a group holding one is dropped whole. Only the user
    action pseudo-classes, `:hover` and its kind, may follow one
    (Selectors 4). 4 tests.
87. **`::first-line` was not built.** The first formatted line of a block,
    a cell or a caption takes the pseudo-element's colour and background,
    and where that line is a child's (a `<div>`'s first line is its first
    paragraph's) the style is handed down to the child (5.12.1). The
    paragraph is laid out as before and, only where the colour differs,
    once more with its text cut where the first line ends: a colour moves
    no glyph, so the lines break where they did. An element on the line
    with a colour of its own, a link, keeps it. The line's font, spacing
    and `vertical-align` are not applied, since each would move where it
    ends; five of the seven `::first-line` tests still failing are
    `vertical-align`, which CSS 2.1 allows there and does not require.
    17 tests.

Round 18 lost none.

### Round 19

This round also ran WPT's `css/css-color` reftests, the first directory
outside CSS 2.1 this runner has measured, since CSS Color 4 is the CSS3
documents are written in: 79 of its 308 passed on X11 before the round and
223 after it (220 on macOS, from 74).

88. **A hex colour of five or seven digits threw from paint.** ntk's X11
    context throws on one, from inside paint, so a mistyped `#ff000` took
    the application down; the Cocoa context drew black. It is no colour
    now, and was shipped alone as the crash it was (#175).
89. **ntk read less of CSS's colour than pages write.** A functional colour
    went to the context as written, and ntk reads the comma forms of
    `rgb()` and `hsl()` and nothing else — reading `rgb()`'s percentages as
    numbers to 255, so `rgb(0%, 50%, 0%)` was nearly black. Tailwind 3
    writes the space form, `rgb(59 130 246 / 1)`, and Tailwind 4's palette
    is `oklch()`. CSS Color 4's functions are read in this package now,
    with its conversions, and handed on as `#rrggbb` or `rgba()`. 3 tests
    here, and most of those `css-color` gained.
90. **A comment joined the tokens either side of it** in a declaration:
    `1/**/0px` was ten pixels, `-/**/10px` a negative margin. It is a space
    there and in an at-rule's prelude, and still nothing in a selector,
    where `.a/**/.b` is one compound. And a number was JavaScript's:
    `1e1px` was no length and `1.px` one. 4 tests.
91. **An invalid `background` reset the background.** The shorthand
    skipped what it did not know, so `background: "red"` cleared the
    colour it should have left alone. An unknown token drops the
    declaration now, and what CSS3 adds to the shorthand is read so that a
    declaration a browser keeps is kept: `/ cover`, `space` and `round`, a
    gradient (drawn as nothing, over the colour), and `right 10px center`,
    measured in from the far edge. 3 tests.
92. **Selector escapes and white space.** `.c\6c ass` is the class
    `class`, a hex escape taking the space after it; the rule index read
    that space as a combinator, and so does css-what 8 when the digits are
    upper case, so escapes reach it in lower case. The index also took only
    a space for the descendant combinator, not a tab, newline or form feed;
    and a string's escaped newline continues its line. 4 tests.
93. **The body's colour and font were the theme's, whatever `html` said.**
    The user-agent sheet set them on `body` as well as on the root, so
    `html { color: green }` stopped there, and the suite colours a good
    many of its tests that way. A fragment's body inherits from an implied
    `<html>` that author rules reach. And a `<body>` with no `<html>` around
    it, which is how a lot of mail starts, did not hand its background to
    the canvas. 9 tests.

Round 19 lost none of CSS 2.1's. `css-color` lost two tests that had
passed by accident: each reference is now drawn right, and each test uses
what is not built, `color-mix()` and a container query.

Three of the syntax tests still failing test CSS 2.1's error recovery where
CSS Syntax 3, which browsers follow, has changed it: `uri-013`,
`declarations-009` and `malformed-decl-block-001`. And one more for the
upstream list:

- **ntk draws a glyph a pixel apart at the start of a run.** Its glyph
  cache is at whole pixels, and a run's origin is where the fraction is
  kept, so a cell starting at a fractional x draws its first glyph
  differently from the same glyph mid-line. 9 `color-applies-to` tests on
  X11, which CoreText, placing glyphs exactly, passes.

### Round 20

This round ran WPT's `css/css-values` reftests too, where `calc()` and its
kin are measured: 40 of their 213 passed on both backends before the round
and 78 after it.

94. **`calc()`, `min()`, `max()` and `clamp()` were not read** (CSS Values 4
    10), so `width: calc(100% - 2rem)`, the commonest of them, was dropped.
    They come down to pixels and a percentage of what layout knows, which
    layout resolves as it does any percentage. A comparison with a
    percentage in it, `min(100%, 600px)`, is a different sum at every width
    and is kept as one; sums and scales distribute into it. A percentage the
    sum cancels is still one, so `calc(40px + 10% - 20% / 2)` against a
    height nothing sets is `auto`. Yoga takes a percentage or points, so a
    flex item's is resolved against its container where that width is
    known. A padding or a size with a percentage has no sign until layout,
    which clamps it at zero. In a table, a cell's width that adds a
    percentage to a length is `auto`, as browsers read it. And `z-index`
    takes an integer: `2.5` is none, where it was 2, and a `calc()` is
    rounded half up. 3 tests here.
95. **A child's width of its own did not bound what it gave its float.**
    The width a float or an inline-block shrinks to was the widest of its
    content, so a 47px child holding a 200px image made its float 200 wide.
    A definite width is the child's contribution, whatever its content does
    past it (CSS Sizing 3 5.1); a percentage one is cyclic there and counts
    as `auto`. A minimum's percentage is of zero there, and an inline-level
    child is measured with its line, so a negative `text-indent` narrows
    it.
96. **A percentage `top` or `bottom` was of the content's height** where
    the content decides that height, in which case it is `auto`, as a
    percentage height is. A percentage `min-height` against such a height
    is zero, which leaves a `calc()` its pixels. 1 test here.

Round 20 lost none, here or in `css-values`. `calc-rounding-001` still fails
on its reference, which sizes the test's boxes with `var()`.

### Round 21

This round ran WPT's `css/css-variables` reftests: 75 of their 182 passed
before it on both backends, many of them by accident, and 170 after it.
Two more of `css-values` pass, whose references use `var()`.

97. **Custom properties and `var()` were not read**, so every colour,
    spacing and font Tailwind or a design system writes through them was
    dropped. A `--name` is kept as written, case and all, per element, and
    inherited as one map; a `var()` is replaced before the declaration it
    is in is read, so it works in a shorthand, in `calc()` and in a colour
    function (CSS Custom Properties 1). One with no value and no fallback,
    or whose value does not parse once it is in, leaves its property
    `unset`; a property in a cycle has no value, whatever its fallback; a
    `var()` that is none as written, an unclosed string cut by a newline
    or a `;` in its fallback, is no declaration, and the end of a style
    sheet closes one it leaves open. A document with neither pays nothing:
    each declaration says whether it sets or reads one.
98. **`:root` matched every element at the top of a fragment.** With no
    `<html>` in the markup, css-select took each top-level element for the
    root, so `:root { color: red }` outranked their own rules. It is the
    `<html>` element now, or the one a fragment's root style is taken from,
    so a fragment's `:root { --brand: … }` reaches all of it.

Round 21 lost none, here or in the other directories.

### Round 22

99. **`color-mix()` was not read**, and Tailwind 4 writes every colour
    with an opacity through it: `bg-blue-500/50` is
    `color-mix(in oklab, var(--color-blue-500) 50%, transparent)`. The two
    colours are taken into the space the mix names, weighted by their
    percentages, which come to less than 100% only at the cost of alpha,
    and mixed premultiplied, so `transparent` lends its alpha and not its
    black; a polar space's hues go the way its hue method says (CSS Color
    5 3). A mix with `currentColor` in it waits for the colour, as the
    keyword does, and `currentColor` in `color` is the inherited colour:
    it kept an earlier declaration's. 7 tests in `css-color`, on both
    backends.

Round 22 lost none, in CSS 2.1 or in `css-color`.

### Round 23

The performance sweep's round 14 (#180) went first, and won two tests
here: a `display: table-column` inside a row drew a background and a border
of its own, which a column does not have, and its paint bounds say it draws
nothing now.

100. **An inline box that `position: relative` moved did not move its
     text**, only its descendants' boxes, so a `<sup>` raised by
     `top: -0.5em`, as Tailwind's preflight and normalize.css raise it,
     sat on the baseline. The box's text is laid out apart from the text
     around it, a fragment at a time, and moved where the box goes once
     the paragraph is laid out, its background and borders with it; the
     line, and the text either side of it, stay where they were (CSS 2.1
     9.4.3). Its paint bounds take the moved text in. A paragraph with
     such a box is laid out a line at a time, as one with an inline-block
     is. 6 tests, 2 of them with the next.
101. **A block inside a relatively positioned inline box stayed where it
     was.** Breaking the inline box around the block (round 15) set the
     block beside the box's pieces, outside their offset, and the offset
     moves it too (9.2.1.1). 5 tests.
102. **`visibility: hidden` on an inline element hid nothing**, and a
     visible element inside a hidden block was not drawn: visibility was
     asked of the block whose lines were being painted. A hidden element's
     text is drawn in no ink now, so it keeps its room, and a visible
     one's text inside it is drawn. Many references reserve room with a
     hidden `<span>`. 2 tests.

Round 23 lost none, in CSS 2.1, `css-color` or `css-variables`. On macOS
four of the nine fail still, by a few hundred pixels each, all of them
CoreText antialiasing the edges of an Ahem square that the reference draws
as a box.

### Round 24

103. **`vertical-align` moved images and inline blocks, never text**, so
     the UA sheet's `sub` and `super` left every `<sub>` and `<sup>` on the
     baseline: footnote markers, exponents and formulas. A raised box's
     text is laid out apart from the text around it, as round 23 lays out
     a moved box's, and drawn off the line's baseline (CSS 2.1 10.8.1).
     `sub` and `super` go down a fifth and up a third of the parent's font
     size and a pixel, as browsers set them; `text-top` and `text-bottom`
     go to the edges of the parent's font; `middle` puts the box's middle
     half the parent's x-height above its baseline; a length raises by
     itself and a percentage by that much of the box's own line height.
     Each raised box adds its own line height to the line box about where
     it is raised to, so a `<sup>` makes its line taller and one with
     `line-height: 0`, as Tailwind's preflight and normalize.css set it,
     does not. A `top` or `bottom` box is aligned with the line box's edge
     and is as tall as all it holds. A raised box's background and borders
     go with it. 23 tests.
104. **The underline an element draws through a raised text** stays on
     that element's baseline, not the text's (CSS Text Decoration 3, 2.1),
     so a line has one underline. An underline the raised box sets itself
     goes with it.

Round 24 lost none on X11. On macOS it won 2 and lost 1, and 20 of the 23
X11 wins still fail there, by 240 pixels each where they missed by 1,880:
CoreText's antialiased edges of the Ahem squares again. The one lost,
`vertical-align-nested-top-001`, is a pixel off by 7 of 255: its two top
boxes' letters are laid out apart and the reference's together, and
CoreText places the second letter a fraction of a pixel differently.

### Round 25

105. **What is in `<head>` was never rendered, whatever the stylesheet
     said.** The box builder skipped `<head>`, `<meta>`, `<title>`,
     `<style>` and `<script>`. The UA sheet's `display: none` is all that
     hides them now, so `head, meta { display: block }` shows a `<meta>`'s
     `::before`, as a browser shows it. Where the markup has no `<head>`,
     what a browser would put in the one it implies stays hidden, whatever
     `* { display: block }` says, as the head it implies is hidden. A
     `<template>`'s content is still never rendered. 6 tests.
106. **A negative margin on an inline box took no room back.** Only an
     edge wider than nothing was laid out, so `margin-right: -4em` was no
     margin at all. It now pulls what follows back over the box. A
     paragraph with one is laid out a line at a time: as a spacer in one
     layout it is a space with negative letter spacing, which CoreText's
     typesetter breaks the line before. 5 tests on X11, 2 on macOS, where
     the other three are Ahem's antialiased edges.

Round 25 lost none, on either backend.

### Round 26

107. **An image in `content` was dropped from the value**, and the rest of
     it drawn, so an icon a stylesheet puts in a `::before` never showed.
     `url()` is an item of the value now, read as a background's is. It
     is an inline image in the pseudo-element, of the style the
     pseudo-element passes on and no other (CSS 2.1 12.2), asked for
     through `onResource` as a background image is. It takes the image's
     size once it arrives and none before. A host that answers as it is
     asked is answered in the same pass: an `<img>` is asked for before
     the boxes are built, and a generated image is known only once they
     are, so the boxes are built again when one arrives that way. 4 tests,
     on both backends; a fifth is closer, and fails on a cell's background.

Round 26 lost none, on either backend.

### Round 27

108. **`unicode-bidi` was not read**, so `bidi-override` reversed nothing,
     `embed` and `isolate` kept no text apart, and `<bdo>` did nothing.
     It is carried out as the controls it stands for (CSS Writing Modes 3,
     2.4.2): an inline box's text is laid out between them, and a block's
     override is one on all its inline content (CSS 2.1 9.10). They are no
     text of the document's: like a spacer, each is a unit of the layout
     a caret, a selection and a copy step over (`LineText.gaps`). HTML's
     rules come with it: `dir` isolates its element, `dir="auto"` and
     `<bdi>` take the first strong letter's direction, and `<bdo>`
     overrides. The `dir` rules are presentational hints, read where the
     attribute is read already, rather than selectors every element would
     try. An embedding does not reach across a padded or bordered
     element's edge, where the line is laid out in pieces. 13 tests on
     X11, 14 on macOS.

Round 27 lost none, on either backend.

### Round 28

109. **`white-space` was read from the block alone.** A `nowrap` element in
     a paragraph that wraps broke between its words, and `pre` text
     dropped the spaces a line ends on from its width, as `normal` text
     hangs them, so a `pre` block in a table cell was narrower than its
     text. Laid out, a space `pre` keeps is a no-break space, as wide and
     as many, so every offset holds, and so is one a `nowrap` element may
     not break after. The space such an element ends on stays breakable
     where the text after it wraps: a break after a space is the call of
     the nearest element holding both (CSS Text 3, 5.1). A `pre` text's
     held spaces are made once a box, so that a pass makes no new string.
     4 tests on X11, 3 on macOS. A `nowrap` run wider than its line is
     still broken inside, which only the engine can stop (`overflow-wrap`).

Round 28 lost none, on either backend.

### Round 29

110. **Text on the baseline took its paragraph's line height.** CSS gives
     every inline box its own, and the line box holds them all (10.8.1): a
     span of 60px lines in a paragraph of 20px ones makes a 60px line, with
     its text in the middle. A paragraph is laid out in one piece, which
     sets every run at the paragraph's line height as a multiple of its
     font's natural one, so the span's text was set 20px apart like the
     rest. An inline box whose own line height is more than that is laid
     out apart now, as a raised box is, and the line takes room for it and
     for every inline box around its text, each about its own baseline. One
     whose own is less is left in the one layout: a `<code>` in a font with
     taller natural lines than its paragraph's has one of those, and the
     line at a time it would take instead is what a long document pays for.
     Whether a box has its own is asked of every inline box in every
     paragraph, so a box with its paragraph's line height, family and size
     is past at once and any other answer is kept on its style. 5 tests on
     X11, 1 on macOS.
111. **A cleared empty block's margins were lost.** Clearance puts the
     block's top border edge below the float, and its margins still
     collapse together, with those of the empty blocks after it (8.3.1).
     The edge is its top margin's depth inside the margin they make, so its
     parent ends where that margin does: past the edge by what the margin
     has more than the top one (10.6.3). Round 11 (item 69) took the
     block's own margins for spent in its clearance, and its parent ended
     at the edge. 2 tests.

Round 29 lost none, on either backend.

### Round 30

112. **A formatting context beside a float took its margins from the
     float.** A block with a formatting context of its own — `overflow`
     other than `visible`, a table — may not overlap a float's margin box
     (9.5), and it was laid out in the room beside the floats as though
     that room were its containing block, so its margins were measured
     from the float. A column with `overflow: hidden` and a 220px margin
     beside a 200px sidebar, the two-column layout of a thousand pages,
     started at 420px. Its margins are its containing block's now, and may
     overlap a float on their own side; only its border box has to clear
     the floats. What is too wide overflows at the end of the line, as far
     as a negative margin there takes it, and a box whose margin at the
     start would push it into a float goes below the float, as Gecko has
     it — the suite's floats-wrap-bfc-with-margin tests settle on that
     where the engines disagree. A float that a negative margin reaches
     past the containing block counts, and one of no width does not: it
     has no area to overlap. Auto margins and HTML's `align` still centre
     the box in the room the floats leave. 5 tests, 2 of them with the
     next item.
113. **`display: flow-root` was not read**, so the declaration was dropped
     and the element stayed a block that let its floats out and its
     children's margins through. It is a block that makes a formatting
     context of its own (CSS Display 3, 2.3), and it is Tailwind's
     `flow-root` and the clearfix CSS has a name for now.
114. **A minimum height that made a box taller let its last child's margin
     out below it.** 8.3.1 collapses a box's bottom margin with its last
     child's only where the box has no `min-height`, which would put the
     margin inside the box; browsers, and the suite, part the margin only
     where the minimum is what sets the height, and spend it: the next
     block starts where the box ends. A maximum leaves the margin to
     collapse through, as 8.3.1 has it: browsers disagree there, and the
     suite has a test either way (margin-collapse-038 against
     max-height-separates-margin). 2 tests.

Round 30 lost none, on either backend.

### Round 31

115. **A box's edges were rounded out rather than snapped.** A background,
     a border, a clip and an image were painted from the pixel their box
     starts in, as wide as the box rounded up, so a rule `1pt` wide was
     two pixels, and two boxes that met at a fraction of a pixel both
     painted the column between them. Each edge is on the pixel it falls
     nearest now, as browsers snap a box, so boxes that meet share the
     column their edge is in. 10 tests on X11, 4 on macOS.

Round 31 lost 2 tests on macOS, both boxes whose height comes from
CoreText's fractional line heights, where the old rounding happened to
land on the reference's pixel; browsers round a font's metrics to whole
pixels before they lay a line out.

### Round 32

116. **A line break straight after `<pre>`'s start tag was text.** HTML's
     parser drops it as an authoring convenience (13.2.6.4.7), and
     htmlparser2 leaves that rule to its caller, so every code block
     written `<pre>` and a line break began with an empty line. The handler
     that builds the tree drops it now, after `<pre>`, `<listing>` and
     `<textarea>`, whose value loses it too, and in a stream whose chunk
     ends between the tag and the line break.
117. **`:lang()` with nothing in it was a selector.** A functional
     pseudo-class given no argument, and one given an argument it does not
     take, make their selector invalid, and with it the group, as an
     unknown name does. `:is()` and `:where()` forgive an empty list. 1
     test.

Round 32 lost 1 test on X11, an XHTML one whose `<pre>` begins with a line
break: an XML parser keeps it, and `<Html>` parses HTML.

### Round 33

118. **Logical properties were dropped**, and they are how Tailwind 4
     writes its spacing: `px-4` is `padding-inline`, `py-2` is
     `padding-block`, `mx-auto` is `margin-inline: auto`, and `inset-0` is
     the `inset` shorthand, which was not read either. A card styled with
     them had no padding, did not centre, and its overlays did not reach
     their edges. CSS Logical Properties 1's margins, paddings, insets,
     borders, sizes and corner radii are read now as the physical ones they
     are in the horizontal writing mode, by the element's direction, and a
     single corner's radius is read as well. The CSS 2.1 suite has none of
     them, and did not move.

### Round 34

119. **`@layer` was dropped, and everything in it.** Tailwind 4 writes all
     of its CSS in `@layer theme, base, components, utilities`, so a page
     styled with it rendered as though it had no stylesheet. Cascade layers
     are read now (CSS Cascade 5): a layer's rank is the order the document
     first names it in, across all of its sheets, a rule in a later layer
     wins over one in an earlier layer whatever their specificity, a rule
     in no layer wins over both, a layer's own rules win over the layers
     inside it, and `!important` turns all of that round. The CSS 2.1 suite
     has no layers either.

### Round 35

120. **A nested rule was dropped, and a media range taken for true.**
     Tailwind 4 writes its variants in both: `md:flex` is `.md\:flex {
@media (width >= 48rem) { display: flex } }`, and `hover:` is
     `&:hover`. The rule nested in a block was read as a broken
     declaration and dropped, and `(width >= 48rem)`, which is no
     `min-width`, was a feature this did not know and so held at every
     width. Rules nest now (CSS Nesting 1): a selector that starts with `&`
     is its parent's with the rest after it, any other `&` is `:is()` of
     the parent, and one with none is a descendant of it, or relative by
     the combinator it starts with; an `@media`, `@supports` or `@layer`
     inside a rule holds declarations for the same selectors. Width ranges
     are read as the bounds they are, a strict one a sixty-fourth of a
     pixel inside its value, and a maximum's breakpoint is as far past it,
     where a width at 2x, `640.5`, lands on the right side of it; it was a
     whole pixel. 1 test: a declaration block with a brace in it, which a
     browser reads the same way.

### Round 36

121. **A flex item was as wide as its row's share and its padding taller.**
     `<Html>` lays a flex container out with Yoga and each item with its
     own engine, through Yoga's measure function, which answered with the
     item's border box: Yoga, which holds the item's padding and border,
     added them a second time. It also answered as wide as the space
     offered, so an item of `width: auto` took a share of the row rather
     than its content's width, and a `content-box` width was read as the
     border box's. The measure answers inside the padding now, as wide as
     the content's max-content width where Yoga offers up to a width or
     none (CSS Flexbox 9.2), and a width, height, minimum, maximum or basis
     of an item's own is its content box's unless `box-sizing` says
     otherwise. An `auto` margin takes the free space on its side, which
     is how `margin-left: auto` puts a button at the end of a nav bar; it
     was a margin of nothing. A row of flex items is as wide as its items
     side by side where it is itself measured, and the flex trees are laid
     out off the pixel grid, since the paint snaps edges: on it, Yoga
     rounded a measured item up and the next one's start to the nearest,
     and they overlapped by a pixel. The CSS 2.1 suite has no flex boxes.

### Round 37

122. **`display: grid` stacked its items as blocks**, where Tailwind's
     `grid grid-cols-3 gap-4` and a card list in `repeat(auto-fill,
minmax(16rem, 1fr))` are the layouts of half the pages written this
     decade. A grid container is laid out now (CSS Grid 1), the subset
     documents use: column tracks of lengths, percentages, `fr`s, `auto`
     and `minmax()`, with `repeat()` by a count or by what fits; items
     placed by line, by span, or in order into the first cells free; rows
     as tall as what is in them, or as the template names them; gaps; and
     items stretched to their areas or aligned in them. A grid container
     is a flex container to the box tree, which makes its children the
     same blockified items, and its own algorithm to the engine, since
     Yoga has none. Named lines and areas, `dense` and column-first
     placement, and subgrids are not read. The CSS 2.1 suite has no grids.

### Round 38

123. **A rounded box's border was drawn square.** Its background followed
     `border-radius` and its border was four straight rectangles over it,
     so a card's or a button's corners had square borders on round
     backgrounds, and an accent down one side did not curve. Where every
     side that has a border has it in one colour and a solid rule, the
     border is the ring between two rounded rectangles now, the inside
     rounded by the radius less the border (CSS Backgrounds 3, 5.2),
     filled by the even-odd rule both backends' contexts take. Sides of
     different colours on a rounded box are still drawn straight. The CSS
     2.1 suite has no radii.

### Round 39

124. **A gradient was drawn as nothing.** `linear-gradient()` was read so
     that a declaration a browser keeps was kept, and painted as no image,
     so a hero section or a button written with one showed its fallback
     colour or none. It is drawn now (CSS Images 3, 3.1), over the colour
     and as an image the size of the padding box, repeated as
     `background-repeat` says — under the borders, and down the canvas
     under a page shorter than the window, which is the stripes a browser
     shows there. Its line runs through the image's centre at its angle,
     as long as the image is across at that angle, with a corner turned
     into the angle whose perpendicular joins the other two corners; its
     stops are where they say, spread between their neighbours where they
     do not, and one past an end lengthens the line rather than being
     clamped to it. A colour interpolation method, `in oklab` as Tailwind 4
     writes it, is read and not honoured: the stops are mixed in sRGB, as
     both backends' gradients mix them. Radial, conic and repeating
     gradients are still drawn as nothing. 1 test, whose hard-stopped
     stripes are covered exactly by the floats and the cleared boxes it
     places.
125. **The runner was kinder than WPT.** It counted the pixels that
     differed by more than a `fuzzy` annotation's `maxDifference` and
     passed a test with no more of them than its `totalPixels`. WPT counts
     every pixel that differs, and fails a test with any pixel beyond the
     difference however few there are. Two tests annotated to allow any
     difference in 150 and 200 pixels passed however much they differed;
     they differ in 10,000 and 440 on X11, and 40,000 and 1,755 on Cocoa,
     so every round above counts both backends two high.

### Round 40

126. **A percentage radius was none.** `border-radius: 50%` was read as
     nought, so an avatar was a square, and Tailwind 4's `rounded-full`,
     written `calc(infinity * 1px)`, dropped its declaration, `infinity`
     being no number `calc()` knew. A radius keeps its percentage now, of
     the box's width across and its height down, so `50%` is a circle on a
     square box and an ellipse on any other; a `/` gives the corners
     vertical radii of their own; and radii that would overlap are reduced
     together (CSS Backgrounds 3, 5.5), which makes the infinity a pill.
     `calc()` reads CSS Values 4's constants, `pi`, `e`, `infinity` and
     `NaN`, and makes of a result that is no finite number what a browser
     does: NaN is nought, an infinity the largest length. An elliptical
     corner is drawn in curves, since the Cocoa context's `roundRect` takes
     circles only and clamps each to half the shorter side, where CSS
     reduces them together. The inside of a rounded border is rounded by
     each radius less the border across it, an ellipse where the borders
     beside a corner differ, and ntk leaves a hairline along a curve two
     subpaths share under the even-odd rule, so a ring whose inside is
     curves cuts its hole backwards under the non-zero one. And an image is
     trimmed to its box's corners: an `<img>` to its content edge's, a
     background to its border edge's. The CSS 2.1 suite has no radii.

### Round 41

127. **A shadow was not drawn.** `box-shadow` was not read, so a card had
     no shadow and an input styled by Tailwind's `ring-1 ring-inset` no
     border, the ring being a shadow that only spreads. Shadows are read
     now (CSS Backgrounds 3, 7.1) — offsets, blur, spread, colour and
     `inset`, as many as are written — and a shadow no colour can be seen
     in is left out, which is four of the six Tailwind writes under every
     shadow utility. An outer shadow is painted under the box's background
     and not under the box: a box's opaque colour covers it, and where
     there is none the box is cut out of it. An inset one is painted over
     the background inside the padding box. A ring, a shadow with no blur
     and no offset, is the band between two shapes, as a rounded border
     is. A blurred one is the canvas shadow of its shape drawn clear of the
     window. ntk does not cache the shadow of a path, and re-blurred every
     one on every paint — thirty cards with a `shadow-md` repainted in
     506ms on the test server — so a blurred shadow, and one cut around its
     box, is drawn once for its geometry and colour on a surface of its
     own, with the cut made there rather than as a clip the size of the
     window, and composited after: 23ms for the same thirty, and 10ms
     without shadows. The CSS 2.1 suite has none.

### Round 42

128. **`aspect-ratio` was not read.** Tailwind's `aspect-video` and
     `aspect-square` boxes were as tall as their content, and nothing at
     all when empty. A ratio makes an `auto` height of the width now (CSS
     Sizing 4, 5.1), of the box `box-sizing` names, and a height it gives
     is one a percentage inside resolves against; the box grows past it to
     hold its content unless it clips (5.2), and a replaced element takes
     it over its own ratio, or, written `auto 16 / 9`, only where it has
     none.
129. **`object-fit` was not read.** An image was stretched to its box
     whatever it said, so an avatar written `object-cover` was squashed.
     It is fitted now (CSS Images 3, 5.5) — within its box, over the whole
     of it, at its own size or the smaller of those two — and placed by
     `object-position`, with what falls past the box cut by a rectangle.
130. **A flex container laid its items out in its border box.** It handed
     Yoga its `height` as the height of its content, so a `border-box`
     height held its padding twice and `h-16 py-2 items-center` centred its
     items eight pixels low; it ignored a percentage height and the ratio
     too. It hands on the content box's height where that is definite now,
     and its `min-height` and `max-height` where it is not, so a column
     `min-h-screen` gives its `flex-1` the rest of the window. The CSS 2.1
     suite has none of the three.

### Round 43

131. **A clamped block showed all of its text.** `-webkit-line-clamp`,
     which Tailwind's `line-clamp-2` writes with the `-webkit-box` a
     browser asks for beside it, was not read, so a card's description ran
     to its end and the cards in a row came out of every height. A block
     shows its first lines now and is as tall as they are, the last cut
     with an ellipsis: the text engine's own `maxLines` and `overflow`,
     which ntk and CoreText both take. A block laid out a line at a time —
     around an image on a line, or beside a float — is cut to its lines
     with no ellipsis, since the engine never sees them together.
132. **`truncate` was a line run past its box.** A `nowrap` block that
     clips with `text-overflow: ellipsis` is one line cut at the box's
     width with an ellipsis now. The engine makes room for it inside the
     line's last word, where a browser fills the line with as much of the
     text as fits, so a line of words shows a little less than it would.
     The CSS 2.1 suite has neither.

### Round 44

133. **A groove was a solid border.** `groove`, `ridge`, `inset` and
     `outset` were read and drawn as `solid`, so a groove in its default
     colour was a black frame, where a browser draws it in two shades
     (WPT borders/groove-default and ridge-default, which require only
     that it differ). They are drawn in two shades now, lit from the top
     left: `inset` shades its top and left, `outset` its bottom and right,
     and `groove` and `ridge` are two bands, one of each. The shades are
     Chromium's — the colour darkened by a third of its brightest channel,
     or where that leaves black, the colour against it lightened — and
     each side is a trapezoid meeting its neighbours on the diagonal,
     clamped to the painted area. 2 tests.

### Round 45

134. **A flex row measured for its content grew into infinity.** A flex
     container laid out at no width limit — which is how a flex item's
     max-content is measured, and a table column's — handed Yoga an
     infinite width, which Yoga took for a width: a `flex: 1` item grew to
     fill it and its text was placed at 1.7 × 10³⁸. The measure came back
     vast, and in Tailwind UI's list item — an avatar and a `flex-1` column
     of a name and an email, beside a column of a role and a badge — the
     role was squeezed until "Designer" broke inside itself. The container
     is `auto` wide there now, which Yoga works out from its content. Found
     rendering a Tailwind-shaped page beside a browser; the CSS 2.1 suite
     has no flex boxes.

### Round 46

135. **A mail's body was centred line by line.** `<td align="center">` —
     around the body table of nearly every HTML mail — is `-webkit-center`,
     which centres the blocks in the cell as well as its text, and it was
     inherited into the table it centres: every heading, paragraph and
     cell of the mail was centred. A browser centres the table and leaves
     its text alone, because a table resets HTML's alignment to `start`
     (Blink: "tables never support the -webkit-* values for text-align").
     So does this now; an author's own `text-align: center` is inherited
     into a table as it always was. Found rendering a transactional mail
     beside a browser; the CSS 2.1 suite has no `align` attributes.

### Round 47

136. **A closed `<details>` showed everything in it.** An FAQ of them was
     every answer at once. A closed one shows its first `<summary>` now and
     nothing else, as HTML renders the rest into a slot that is out of the
     box tree until the element is `open`. The summary is a list item with
     HTML's marker, `disclosure-closed` and, in an open one,
     `disclosure-open` — ▸ and ▾, as Blink draws them — and is no longer
     bold, which no browser makes it.
137. **An inside marker was drawn over its item's first letters.** A
     `list-style-position: inside` marker was laid out apart and set at the
     item's content edge, where its text also starts, so every inside list
     — Tailwind's `list-inside` — read `•Item` with the two on top of each
     other, and so would every summary. It is the first inline content of
     the item now, the marker and a space, and takes its room on the first
     line as `::marker` does. That is also what the CSS 2.1 suite asks of
     one: an item that starts with a block has its marker on a line of its
     own above the block, and an empty item beside a float is a line tall,
     with its marker set past the float. 4 tests.

### Round 48

138. **`text-align: justify` was set as `start`.** Neither text engine
     justifies, so it had been left ragged. Each line of a justified
     paragraph but its last, and one a forced break ends, is laid out again
     with its spaces widened by their share of what the line leaves of the
     box — the spacing `word-spacing` is drawn with, so a copy takes the
     text as written. The share is measured with the spaces already apart,
     because neither engine measures a space that is a spaced run of its
     own as it measures it inside its run — ntk loses the kerning pair it
     made, and CoreText drops the font's pairs where it spaces a glyph —
     and a line measured the other way came out wider than its box and
     broke a word early: on macOS, in Helvetica, half of a paragraph did. A
     ragged paragraph keeps its layout across the widths its breaks hold
     at, and a justified one is laid out twice more at each: 2.1 ms against
     0.12 to lay out a sixty-paragraph article at a new width, and nothing
     for text that is not justified. 3 tests on X11; on macOS the same
     three come within a pixel's fringe of their references, where text
     drawn over other text is anti-aliased twice.
139. **Text that does not wrap ignored `text-align`.** A layout given no
     width to break at — `white-space: nowrap` or `pre` — is aligned by the
     text engine within its own widest line, which for one line is no
     alignment at all: a centred `<td nowrap>`, a label in
     `whitespace-nowrap` and `text-center`, and every right-to-left
     `nowrap` line were set flush left. Each such line is placed in its box
     now, and one too long for it is set at its start and overflows its
     end — its left, in a right-to-left paragraph — as Blink sets it. 1
     test on X11, whose right-to-left `nowrap` line was set at the left.
     Found in the justify tests, which set `nowrap` and `pre` beside
     `justify` to check that it is ignored there.

### Round 49

140. **A truncated block kept its first line.** `text-overflow: ellipsis`
     was the paragraph's cut, one line with an ellipsis, so a `truncate`
     block with a `<br>` in it, or a `<pre>` that clips with an ellipsis,
     showed its first line and lost the rest — and on macOS, where
     CoreText cuts at a line by folding the rest of the text into it, its
     lines ran together into one. `text-overflow` cuts every line that
     overflows, and a layout can cut only its last, so such a text is laid
     out a hard line at a time, each cut apart, as a long `<pre>` is
     already laid out in chunks. A clamp is the paragraph's, and stays one
     layout. Found reading the cut for round 48; the CSS 2.1 suite has no
     `text-overflow`.

### Round 50

141. **A kept tab was a space wide.** Neither engine has CSS's tab stops:
     ntk draws a tab a space wide, and CoreText sets it at its own stops,
     every 28 points. So Go indented with tabs came out indented by one or
     two characters a level, and columns a tab apart did not line up, in
     every `<pre>` of code or of tab-separated text. A tab `white-space`
     keeps is set at its stop now: one every `tab-size` spaces of the
     block's font from the line's start — `tab-size` and `-moz-tab-size`,
     as a number of spaces or a length, are read — and one that would
     land less than half a `ch` short of a stop goes on to the next (CSS
     Text 3, 4.2). A tab is laid out as a space spaced out to its stop,
     which the document still holds as a tab, as a copy takes it; where
     each starts — past any padding or word spacing before it — is read
     off one more layout of its paragraph, made only where there is a
     tab, and off the tab's own run there rather than a caret, which
     CoreText sets part of the way into a spaced glyph's spacing. A line
     `pre-wrap` wraps sets the tabs after the wrap as though it had not,
     and a right-to-left line sets them a space wide. A `<pre>` of 2,000
     tab-separated lines lays out in 6 ms where the same with spaces takes
     0.5, and a document with no tab pays nothing. 1 test on each
     backend, `content-white-space-002`, whose generated content keeps a
     tab. Found rendering a README beside a browser.

### Round 51

142. **Text was shaped with none of the features its style asked for.**
     `font-variant-numeric` — Tailwind's `tabular-nums`, which keeps a
     column of figures from shifting as they change, and matters on macOS,
     whose `sans-serif` has proportional figures — and the other
     `font-variant` longhands, the `font-variant` shorthand beyond CSS
     2.1's `small-caps`, `font-kerning` and `font-feature-settings` were
     dropped. They are read now, inherited, and handed to the text engine
     as the run's OpenType features, which both engines shape with: the
     variants' first and the settings' last, as CSS Fonts 3 orders them.
     A variant is the font's own feature, so `small-caps` is drawn in
     small capitals where the font has them and in the font's lowercase
     where it has not; none is synthesized. The features of a style are
     one kept object, since a layout is found again by its runs' fields
     compared by identity. The CSS 2.1 suite's `small-caps` tests set a
     variant beside the same variant, and none of them moved.

### Round 52

143. **Text cast no shadow.** `text-shadow` — a hero heading's glow, a
     label's hard outline — was dropped. It is read now, inherited, and
     painted under the text and its underline, the last shadow first. The
     engines draw a layout's glyphs in its runs' own colours, so a shadow
     is the layout drawn again clear of the window to the left, with its
     shadow offset back by as much, as a box's blurred shadow already was:
     only the shadow lands. A hard shadow is blurred a hundredth of a
     pixel, because CoreGraphics casts none with no blur at all. A layout
     whose runs do not all cast the same shadows — a `<span>` with one in a
     paragraph — draws each stretch's shadows clipped to it, a line at a
     time, and letters beside the stretch, as near it as its blur reaches,
     cast into the clip too. Which a layout casts is worked out once, by the paragraph's map
     of runs to their boxes rather than by the layout, which a paragraph
     of the same runs may share while casting other shadows. A block with
     no shadowed text pays nothing. Found rendering a landing page beside
     a browser; CSS 2.1 has no `text-shadow`, and neither suite moved.

### Round 53

144. **A footnote mark made its line no taller.** An inline box is on its
     line with its own line height, about its own baseline, whether or not
     it holds text of its own (CSS 2.1 10.8). A raised box's was counted
     only where it set a line height the engine would not have given its
     text anyway, so a `<sup>` holding a smaller `<a>` — every footnote
     mark in an article — counted the `<a>`'s line and not its own, and an
     empty raised box counted nothing: the line was 3px short of a
     browser's under a footnote mark in 16px text, and 6px under a raised
     `<span>` around a smaller link. A raised box's own room counts now,
     from its text and, where it has none on the line, from its edge,
     which a raised box always has. Found rendering an article with
     footnotes beside a browser; the CSS 2.1 suite's raised boxes all hold
     their own text, and neither suite moved. An inline box on the
     baseline whose text is all in smaller boxes inside it still counts
     only theirs — `<span style="font-size:20px"><small>x</small></span>`
     is 26px tall where a browser makes it 32 — since counting its own
     would take every paragraph with such a box off the one-layout path.

### Round 54

145. **`::marker` rules were read and not applied.** A selector ending in
     `::marker` parsed, matched nothing and styled nothing, so every list a
     stylesheet styles through its markers was set in its items' colour:
     Tailwind's `prose` greys its bullets and mutes its numbers, and both
     came out in the text's colour, and a list of `list-style: none` with
     a `::marker` `content` — a checklist — had no marker at all. A list
     item's `::marker` style is computed now, inheriting from the item: an
     outside marker is set in its colour, font, weight and slant, an inside
     one is an inline box in it, and a `content` of strings is the marker
     text, as written, while the list counts on under it. `content: none`
     is no marker. Found rendering a page styled as `prose` beside a
     browser; CSS 2.1 has no `::marker`, and neither suite moved.

### Round 55

146. **Every underline was two pixels below the baseline and one thick.**
     `text-underline-offset` — shadcn's links, Tailwind's
     `underline-offset-4` — and `text-decoration-thickness`, and a length
     in the `text-decoration` shorthand, were dropped. They are read now:
     the offset from the alphabetic baseline down, as Blink measures it,
     inherited, and the thickness of the box that sets the underline,
     which it propagates with the underline's colour and style; either as a
     length or a percentage of the font size, and `auto` leaves the rule
     where it was. A run carries both to the painter `<Html>` shares with
     `<richtext>`, whose own runs can set them too. Found in a survey of the
     properties real stylesheets write that were dropped; CSS 2.1 has
     neither, and neither suite moved.

### Round 56

147. **Every background was drawn at its own size.** `background-size`
     parsed its three keywords and nothing else — its lengths, in the
     longhand and after the `/` in `background`, were read as `auto` —
     and the painter never asked it: a hero's `cover` photograph was tiled
     at the size it was saved at, an icon set as `16px` was as large as
     its file, and Tailwind's `bg-cover` and `bg-[length:…]` did nothing.
     A tile is sized now as CSS Backgrounds 3 has it, over CSS Images'
     sizing of an object: `cover` and `contain` scale the image to fill
     its positioning area or to fit it, keeping its ratio; a width or a
     height alone takes the other from the ratio, or else from the
     image's own size, or else from the area; percentages are of the
     area. A gradient, which has no size or ratio of its own, is tiled at
     the size given and placed by `background-position`, as an image is,
     and cut to a rounded box's corners rather than drawn as one fill of
     its shape. A tile at the image's own size is still one pattern fill;
     any other is drawn a tile at a time. Found in a survey of the properties real
     stylesheets write that were dropped; CSS 2.1 has no
     `background-size`, and neither suite moved.

### Round 57

148. **A background drew one of its layers.** The `background` shorthand
     kept its last comma group and `background-image` its first, so the
     hero every landing page has — `linear-gradient(rgba(0,0,0,.5),
rgba(0,0,0,.5)), url(hero.jpg) center / cover` — was the photograph
     with no shade over it, or the shade over nothing, depending on how it
     was written; and two icons placed by one `background-image` were one.
     A background is every layer now (CSS Backgrounds 3, 2.1), painted
     bottom first over the colour, which is the last layer's: the number
     of images decides how many there are, and `background-repeat`,
     `-size`, `-position` and `-attachment` each give a value a layer,
     taking them over again where they have fewer. A single layer is what
     it was, with no list and nothing more to paint — the lists exist only
     where there is more than one. Every layer's image is asked for through
     `onResource`. Found in a survey of the properties real stylesheets
     write that were dropped. CSS 2.1 has one layer, but one test in the
     suite draws its pass condition as a sized image over a second layer
     of red (`visudet/line-height-201`), and it passes now on X11.

### Round 58

149. **`fit-content`, `max-content` and `min-content` were not widths.** A
     `width` of any of them was a declaration nothing could read, so it
     was dropped: `w-fit` left a block filling its row, a badge in a card's
     column was stretched across it, a tooltip placed with both offsets and
     `mx-auto w-fit` spanned its container, and `w-full sm:w-fit` kept the
     full width at every size. They are read now beside an `auto` length,
     so what does not know them sizes the box as it did, and a block, a
     float, an inline-block, an absolute box and a flex item are sized by
     them as CSS Sizing 3 has it — its content's max-content width, its
     min-content width, or the first where the room holds it and the room
     where it does not, never less than the second — and `min-width` and
     `max-width` take them too, so `min-w-max` keeps a row item whole. The
     two widths are measured once a box, as a table cell's are. A height
     of one is its content's, which `auto` already is. Found in a survey
     of the properties real stylesheets write that were dropped; CSS 2.1
     has none of them, and neither suite moved.

### Round 59

150. **`text-wrap` was dropped.** Tailwind 4 writes `text-nowrap` as
     `text-wrap: nowrap`, not as `white-space`, so its labels wrapped; and
     `text-balance`, which headings are written with to keep a word from
     ending one alone, did nothing. CSS Text 4 makes `white-space` a
     shorthand of `white-space-collapse` and `text-wrap-mode`, and each of
     those, and `text-wrap`, now changes its half of the one value the
     engine keeps — `pre` then `text-wrap: wrap` is `pre-wrap` — with
     `break-spaces` read as `pre-wrap`. `text-wrap: balance` is inherited
     and, on a paragraph of two to six lines laid out in one piece,
     breaks it at the narrowest width that keeps as many lines, found by
     halving the width with the engine breaking the lines, and sets them
     in the whole width: the probe heading breaks where Chrome breaks it.
     `pretty` and `stable` wrap as `auto` does. Found in a survey of the
     properties real stylesheets write that were dropped; CSS 2.1 has
     none of them, and neither suite moved.

### Round 60

151. **What a translation centres hung off to the right.** The most common
     way a page centres a badge, a modal or a play button on a point is
     `left: 50%` and a translation back by half its own width — Tailwind's
     `absolute left-1/2 -translate-x-1/2`, written as `translate` in
     version 4 and inside a `transform` in version 3, or a hand-written
     `transform: translate(-50%, -50%)` — and both properties were
     dropped, so the box started at the middle. `translate` is read now,
     and the translation a `transform` makes, from its translate functions
     and its matrices, with rotating, scaling and skewing read and not
     drawn; the box is moved after layout by the same pass that moves a
     relative one, a percentage being of its own border box. A
     transformed box is a containing block for the absolute and fixed
     boxes inside it and is painted with the positioned boxes, as a
     browser paints it. Found in a survey of the properties real
     stylesheets write that were dropped; CSS 2.1 has no transforms, and
     neither suite moved.

### Round 61

152. **A shrink-to-fit box had its containing block's whole width.** CSS
     2.1 gives a float, an inline-block and an absolute box of `width:
auto` the room its margins leave (10.3.5, 10.3.9), and an absolute
     box also the room left beside the offset it has, or beside its static
     position where it has none (10.3.7). Each took the containing block's
     width instead: a float with side margins and text enough to wrap
     stood out of its containing block by them, and a box placed at
     `left: 50%` — the other half of the centring round 60 made work —
     ran past its end rather than wrapping in the half it has. The room
     is the containing block's less the margins and that offset now, and
     percentages are still of the containing block; the five cases in the
     test measure what Chrome measures. With the room right, the part of
     the rule the engine had skipped matters — `min(max(min-content,
room), max-content)`, the longest word flooring the box — and
     `floats-clear/floats-121` said so the first time the suite ran: a
     float with a 200px word in 199px of room is 200px wide. The
     min-content width is measured now, and kept on the box — but only
     where a word may be wider than the room, which is rare. As first
     shipped it was measured wherever the content did not fit the room,
     by a probe a pixel wide, and ntk makes that fifteen to thirty times
     an ordinary layout: every word is too wide for a pixel, and each is
     searched for a place to cut it, shaping a prefix at every step. A
     page of wrapping floats and inline-blocks took four times as long to
     lay out. The floor is bounded now before it is measured: from each
     word's characters, at half again their size, and where that is past
     the room, from the words laid out one to a line at no width limit;
     the probe runs only where that too is past it — a URL, a long
     compound — and the page lays out as fast as it did before. Found
     comparing round 60's probe with a browser.

### Round 62

153. **A gradient headline was a bar with no words in it.** The way a
     landing page colours its headline is Tailwind's `bg-gradient-to-r
from-… to-… bg-clip-text text-transparent`: the background clipped
     to the text, and the text itself no colour at all. `background-clip`
     was dropped, so the box was painted with the gradient and the text
     drawn in no ink over it — a coloured bar where the words were — and
     a gradient `<span>` inside a heading vanished outright; with
     `-webkit-text-fill-color: transparent` instead, also dropped, the
     text sat in its colour over the bar. `background-clip: text` is read
     now, and `-webkit-text-fill-color` as the glyphs' own fill, apart
     from `color`, which the decorations keep. A box that paints its
     background through its text paints no box; a paragraph holding such
     text is laid out through a recorder, and paint lays the same runs out
     again with no ink of their own — which ntk fills with the context's
     fill picture and react-x11's CoreText context with a gradient
     natively — and draws that layout with the background as the fill,
     clipped to the runs that are the box's, so the text around them keeps
     its ink. A document with none pays one flag. Found rendering a landing
     page beside a browser; CSS 2.1 has no `background-clip`, and neither
     suite moved.

### Round 63

154. **`display: contents` was dropped, and its element stayed a block.**
     Tailwind's `contents` takes a wrapper out of a layout — a component's
     root inside a flex row or a grid, whose children are meant to be the
     row's items — and the element kept its box: the row had one item
     where it should have had several, its children stacked inside it.
     An element of `display: contents` makes no box now (CSS Display 3,
     2.5): its `::before`, its children and its `::after` go into its
     parent's box, in its style, so they inherit from it and are the flex
     items or grid items their grandparent lays out; its counters are
     changed and scoped as an element's are; and a replaced element set
     so, which has no children to hand on, is not rendered. Found in a
     survey of the display values stylesheets write; CSS 2.1 has no
     `contents`, and neither suite moved.

### Round 64

155. **Outlines were not drawn.** CSS 2.1 has `outline` (18.4), and pages
     draw rings with it that take no room: a focus ring, an avatar's
     ring, and Tailwind UI's `outline -outline-offset-1 outline-black/5`,
     the hairline it lays over an image's edge. All of it was dropped.
     `outline`, its width, style and colour, and `outline-offset` are read
     now, and an outline is drawn as a border of its own round the border
     box grown by the offset — inside it, where the offset is negative —
     with the box's rounded corners grown along with it, through the
     painter the borders are drawn with, so its styles are theirs. It is
     drawn over the box's content, outside the box's own clip, and an
     inline box's round each of its fragments; the paint bounds count it,
     so a repaint that reaches it redraws it. `auto` is drawn solid.
     Found in a survey of the properties real stylesheets write that were
     dropped.

### Round 65

156. **A list's bullet was never its image.** `list-style-image` was not
     read, so a custom bullet — a check mark, a brand's dot — was the
     type's disc; and the `list-style` shorthand took a `url()` for a
     type and read `none` by a rule of its own. `list-style-image` is read
     now, and the shorthand as CSS 2.1 12.5.1 has it: a type, a position
     and an image, each at most once and each reset where it is left out,
     and a `none` that is whichever of the type and the image is not
     otherwise given — both where neither is, and none at all, which makes
     the declaration invalid, where both are. An item's image is asked for
     through `onResource` as a generated image is, and is its marker once
     it arrives: outside, its bottom on the first line's baseline and the
     gap a bullet has before the content; inside, an inline image at the
     start of the first line. Until it arrives, and where it never does,
     the type's marker stands. An outside image taller than its line hangs
     over the line above rather than making its line taller, as a browser
     does, and an empty item's marker beside a float is not moved past the
     float (`list-style-image-applies-to-017`); both are markers' as a
     whole, text or image. Four tests pass on both backends: two of the
     shorthand's `none` (`lists/list-style-020`, `-021`) and two CSS1 tests
     whose lists are styled through it.

### Round 66

157. **A float in a paragraph went at the paragraph's top.** Every float
     in an inline formatting context was placed before the first line was
     built, so an image floated from the middle of a paragraph stood
     beside its first line, and the lines above its anchor wrapped round
     it. A float is placed as the lines reach it now (CSS 2.1 9.5.1): at
     the top of the line it is met on, where it fits beside what the line
     holds already, which moves over for it; and at the top of the next
     line where it does not, the rest of its own line staying on the line,
     as a browser has it. Six tests on X11 and five on macOS: three in
     `floats` (`float-nowrap-1`, `floats-placement-006`,
     `floats-placement-vertical-004`), `inlines-013`,
     `static-inside-float-inside-inline`, and `stack-floats-003` on X11.
158. **A word with too little room left on its line was cut to fit it.**
     Text laid out after something else on its line — an inline-block, or
     the float it is cut at now — has what is left of the line, and both
     engines break a word wider than that inside itself: the first letter
     at the line's end, the rest on the next. A word that may start a
     line, after a space the line ends on or after an atomic, goes to the
     next line whole now; one glued to what is before it, a full stop
     after a padded `<code>`, stays. `floats-031`, on both backends.

Round 66 lost four tests on both backends, `float-nowrap-3`, `-7`, `-9`
and `float-nowrap-hyphen-rewind-1`, and none of them for their floats. In
each a word is wider than what is left of its line — nowrap text, which
both engines break inside where CSS lets it overflow, or a word a browser
hyphenates and neither engine does — so the test and its reference, which
put the float at different places in the text, put it on different lines.
They passed while every float went at the top of its paragraph, where the
two agreed.

### Round 67

159. **A gradient or a shadow past ±32,767 pixels threw from the paint.**
     X RENDER takes a gradient's ends and a path's outline in 16.16 fixed
     point, and nothing cut either to what a paint reaches: a
     `linear-gradient()` down a long document's wrapper, scrolled far
     enough, a stop at `calc(Infinity * 1px)`, or a blurred `box-shadow`
     down a box tens of thousands of pixels tall threw a `RangeError` out
     of the X11 paint, and took the application with it. A gradient whose
     ends would pass ±16,384 has its line cut to the part the fill
     covers, moved along its perpendicular to run through it and ending in
     the colours the whole line has there; a shadow's shape, its clip and
     the box it is cut around are cut to the painted area and as far again
     as its blur reaches, as a background already was. Found running
     nineteen more of WPT's `css/` directories for crashes, 9,942
     reftests: `css-text`, `css-flexbox`, `css-grid`, `css-tables`,
     `css-display`, `css-lists`, `css-inline`, `css-backgrounds`,
     `css-position`, `css-sizing`, `css-box`, `css-overflow`,
     `css-pseudo`, `css-transforms`, `selectors`, `css-cascade`, `css-ui`,
     `css-align` and `css-images`. Eleven gradient tests crashed there
     (`css-images/gradient/gradient-eval-*`, `gradient-infinity-*`) and
     none does now; nothing else crashed or hung. The shadow was found by
     a page of such boxes, made to look for more.

### Round 68

160. **Pages a fuzzer made crashed the renderer 24 times in 3,000, and
     hung it twice.** `fuzz.ts` cuts up this suite's tests (above), and
     what it found was mostly depth:
     - **A box that sizes itself was laid out again at every level of
       nesting.** A flex item's content is laid out to measure it, and was
       measured again for every layout of its container; a float, an
       inline-block and an absolute box measured theirs on every layout
       too; and the walk for the paint bounds went into an inline-block
       from its line and again from its parent. So each level laid out all
       it held two or three times over: twelve nested flex boxes took two
       seconds, and a hundred nested floats never finished. A flex item's
       max-content width and a shrink-to-fit box's are measured once in the
       box's life now, as a table cell's are; a box that sizes itself, laid
       out at the same width earlier in the pass, is moved rather than laid
       out again; and the walk goes into each box once. Forty levels of
       any of them lay out in a millisecond.
     - **Past about 150 nested flex boxes Yoga's own stack ran out**, each
       running its pass inside the measure of the one around it: a
       `RuntimeError` out of the layout. Past 64 one is laid out as blocks.
     - **Past a few hundred nested elements the stack ran out** in the
       walks of the document, where a table built four boxes a level. The
       parser keeps a document to 256 levels, as Chrome's does to 512:
       what is opened deeper goes into the element at the limit.
     - **A `1e308px` length** added up past what a number holds, and core
       refused the element's infinite height with a throw. A length is kept
       to ±33,554,428 pixels, as a browser keeps it and as `calc()` already
       did, and a font size to 10,000.
     - **Whatever still throws** from the layout or the paint leaves the
       document blank, reported once through `console.error` outside
       production, rather than ending the application.

     After them, three runs of 3,000 pages (seeds 1 to 3) crash nowhere and
     hang nowhere; one page of seven hundred nested tables takes twenty
     seconds in the harness's own X server. The CSS 2.1 suite does not move
     on either backend.

### Round 69

161. **A grid in a grid in a grid was laid out three times a level.** The
     fuzzer's pages are this suite's by default; `--from` makes them from
     other directories, and it was given ten — `css-grid`, `css-text`,
     `css-flexbox`, `css-backgrounds`, `css-sizing`, `selectors`,
     `css-values`, `css-color`, `css-display` and `css-variables` — with
     the tokens their documents are made of put in besides: grid templates,
     areas and spans, `aspect-ratio`, `oklch()`, `color-mix()`,
     `fit-content()`, `:has()`, nesting, `clamp()`, custom properties that
     name each other. Four pages of 3,000 hung, and all four were grids
     nested in grids: a grid item's min- and max-content widths were
     measured for every layout of its grid, as a flex item's were before
     round 68, and twelve levels took two thirds of a second. They are
     measured once in the box's life now, as a table cell's are, and twelve
     levels take a millisecond.
162. **A float went up into a gap the floats before it had left.** CSS 2.1
     9.5.1 keeps a float no higher than the top of any float before it
     (rule 5); here one that fitted in the room beside a tall float, which
     the float after that had gone under, went back up into it. Three
     tests on both backends: `floats-141`, `floats-146` and
     `floats-placement-005`. Looking for that room was also the cost: each
     float walked the bottom of every float in every row above its own, so
     a gallery of a thousand floated thumbnails took 0.7 seconds to lay out
     and two thousand took six. They take 8 and 22 milliseconds now.
163. **A nest of right floats laid out what it held once a level.**
     Measured at no width limit, a right float stands at an infinite x, and
     its box went there: nothing in it could be moved back from infinity,
     so all of it was laid out again at its next layout — the content of
     the innermost of a nest of them as many times as there were levels.
     A page the fuzzer made from a `css-multicol` crash test, every element
     floated right, 250 levels deep around 4,000 floats, took 24 seconds;
     it takes 0.2. The box goes at the left now; what a measure reads of it
     is its width, and the float context keeps where it stands.

     Found by 3,000 more pages from the other 27 directories of the
     checkout, `css-tables` to `css-writing-modes`. Of the 6,000, nothing
     else crashed or hung.

### Round 70

164. **A box as wide as its content took the widest of its floats for how
     wide they came to.** A float, an inline-block, a table cell and
     anything else its content sizes is as wide as that content at its
     widest, and floats stand side by side there: beside the line they are
     met on, and among blocks as many as come together. Taken one at a
     time, a floated menu's items went one under another, the text beside
     a floated image in an inline-block wrapped under it, and a float
     around a linked, floated logo was no width at all, since the logo was
     in the link and the link measured as a line holding nothing. At its
     widest a box now measures a line with the floats placed at its top,
     and floats among blocks side by side until a block in flow starts a
     row of its own, which one with a formatting context of its own stands
     beside (as Blink measures them). At its narrowest each is alone, as a
     word is. Three tests on X11 and two on macOS: `floats-143`,
     `intrinsic-size-float-and-line`, and `text-indent-012`, an absolute
     box around a float and an indented inline-block that is as wide as
     the three of them.

### Round 71

165. **A table in a table in a table was laid out again at every level.**
     A table's cell is laid out as its table is, and a table in the cell
     as the cell is, so every level laid out all it held again, and the
     fuzzer's pages of a few hundred nested tables around a few thousand
     more took five to twelve seconds. A table asked for at a width it was
     laid out at earlier in the pass, and not laid out over since, is moved
     there now, as a box that sizes itself has been since round 68: the
     same pages take 0.2 and 0.5 seconds, and forty nested tables of mail
     a third of what they did.
166. **A box clipped to no area painted what it held through a mask the
     size of the window.** An empty rectangle is no rectangle to ntk's
     context, which clips through an a8 mask for anything that is not one
     and builds it again at every restore — so a nest of such boxes, the
     fuzzer's seven hundred nested tables with `overflow: auto` and nothing
     in them, took 46 seconds to paint in the harness's X server. Nothing
     in a box clipped to no area shows but an absolute box whose containing
     block is outside it, and where it holds none, what it holds is not
     painted now. The everyday case is a menu at `max-height: 0`.

     After them no page of the five fuzzed corpora crashes or hangs, and
     this suite does not move.

### Round 72

167. **A list counted with a counter of its own.** An `<ol>`'s items were
     numbered by a stack in the box builder, beside the CSS counters
     `counter()` reads, so `counter(list-item)` came to 0, `<ol reversed>`
     counted up, and neither `counter-set` nor `reversed()` was read at
     all. Lists count with CSS Lists 3's `list-item` counter now: `ol`,
     `ul` and `menu` reset it, a list item adds one to it, or takes one
     from it where it counts down, and HTML's `start`, `value`, `reversed`
     and `type` are hints for it. A reversed counter written with no number
     starts at what its scope counts (4.4.2), so `<ol reversed>` counts
     down to 1, and to an item's `value` before it. A marker is its type
     written out — Greek, Armenian and Georgian among them — or a string
     (`list-style-type: "→ "`), set against the content with no gap, or
     its `::marker`'s `content`, counters and all; and an outside marker
     in a right-to-left item stands at its right and reads right to left,
     its full stop before the number.
168. **A counter reset in an element whose parent had one reached the
     element's later siblings.** That was CSS 2.1's rule, which CSS Lists 3
     narrows: such a reset nests a counter for the element's own
     descendants, and the parent's goes on after it — a reset in a
     `::before`, or in an element among others that count.

     `css-lists`: 27 of its 143 tests passed on X11, 117 do now. The one
     lost, `marker-text-matches-disc`, passed with a disc for a counter
     style this does not know (`@counter-style` extending `disc`), which is
     decimal. This suite wins `counter-reset-increment-002` on both
     backends and loses four written to CSS 2.1's rule, which Chrome fails
     as this does now: `content-counter-006`, `-007` and `-008` and
     `counters-010`, whose nested resets reach their later siblings (two of
     them on X11, where the other two fail for their fonts).

### Round 73

169. **A flex item was shrunk under what it held.** CSS Flexbox 4.5 keeps
     an item with `min-width: auto` in a row, or `min-height: auto` in a
     column, no smaller than its content comes to, and Yoga has no such
     minimum: a row's items were shrunk under their images and
     inline-blocks, which then ran out over the next item, and a column's
     first item under its content, which the next one was drawn over.
     `min-width` and `min-height` are `auto` now, as CSS 3 has them, so
     that `min-w-0` — which lets an item go, and which Tailwind writes for
     exactly that — is told from what they are set to; outside a flex item
     `auto` is 0. The minimum is asked of an item only where its content
     overflows it at the size Yoga gave it, laid out as the final pass
     keeps it, so a row with room pays nothing, and the Tailwind
     dashboard's layout does not move. Six tests in `css-flexbox`, and
     none in this suite; a word too long for its item is still broken
     inside itself where a browser lets it overflow, as both engines break
     one everywhere.

### Round 74

170. **What was in a stretched or flexed item had no height to take a
     percentage of.** CSS Flexbox 9.8 makes an item's height definite once
     the flex layout has settled it: an item stretched across a row with no
     height of its own, and an item flexed along a column that has one.
     `h-full` in a sidebar, or `h-1/2` in a column's `flex-1` panel, took a
     percentage of nothing, and was as tall as its content. Such an item is
     laid out again at the height its line gave it, where something in it
     asks for a percentage of that — asked once of each box and remembered,
     so an item with nothing of the kind in it is laid out once, as it was.
171. **A column's item with a height of its own was shrunk under its
     content.** Round 73's minimum passed it over, and Yoga, which has
     none, shrank it as far as the column asked; 4.5 keeps it no shorter
     than the lesser of its height and what its content comes to. That is
     measured as an intrinsic size is, with no height for a percentage in
     it to take; an image's is its height, and an item with an
     `aspect-ratio` counts its width through the ratio as content, so a
     square in a column with no room stays square, as Chrome keeps it.
     `min-height: min-content` asks for the content's height whatever the
     item's `overflow`, and `flex: content` parses.

     `css-flexbox`: 522 of its 1,012 tests passed on X11, 555 do now, and
     `css-sizing` 217 of 562, 220 now; none lost in either, and none moved
     in this suite.

### Round 75

172. **A `ch` was half an em.** CSS Values 4 makes it the advance of the
     font's "0", and that is what it is now, laid out once per face and
     size where the cascade meets one, as `ex` already asked for the
     x-height: a monospace font's "0" is three fifths of an em, Arial's a
     little over half, and Ahem's the whole of one. Tailwind's `max-w-prose`
     is `65ch`, so a prose column was an eighth narrower than a browser
     draws it, and a `20ch` column of code held seventeen characters.
173. **A float met where its line cannot break went beside the text before
     it.** In text that does not wrap, what follows the float is on its
     line whatever the room, so the float goes at the line's top only
     where that fits beside it as well, and under the line where it does
     not, as browsers place it; it went at the top wherever it fitted
     beside the text before it, and the text ran on under it.
     `float-nowrap-8` had passed only because its `10ch` box was narrower
     than its text.

     `css-text`: 454 of its 1,489 tests passed on X11, 568 do now; that
     suite sizes most of its boxes in `ch`. The five it loses passed with
     test and reference drawn equally wrong in boxes half an em a `ch`:
     two whose `word-break: break-all` wants a break between any two
     letters, which the engines emulate by cutting a word where the line
     runs out; two whose `break-spaces` spaces must not hang; and one whose
     U+2010 the monospace face does not have.

### Round 76

174. **A word too long for its line was cut inside itself.** CSS Text 3's
     `overflow-wrap: normal`, the initial value, lets such a word run past
     its line's end, and the text engine cut every one, as `break-word`
     has it: a long URL in a narrow column was broken across lines where a
     browser lets it overflow. ntk 8.13.0 keeps a word whole where it is
     asked to, and `<Html>` asks unless the paragraph says a word may be
     cut: `overflow-wrap: break-word` or `anywhere`,
     `word-break: break-all` or `break-word`, or `line-break: anywhere`,
     the last two emulated, as near as the engines come, by cutting. The
     engine answers for a paragraph, so an element in it that asks has the
     paragraph's words cut, and text in a script written without spaces
     is cut regardless: the engine finds no words in it. The same release
     starts a line too long for its box at its start edge whatever
     `text-align` says, where a right-aligned one was pushed out of the
     box's left side. CoreText, on macOS, cuts a word too long whatever
     the style says, as it did.
175. **`truncate` put its ellipsis a word early.** A `text-overflow` cut on
     a line that does not wrap was the engine's `maxLines: 1`, which wraps
     the text first and ends the first line with the ellipsis, after the
     last word that fitted, where a browser fills the box and cuts inside
     a word. ntk 8.13.0 lays such a line out unwrapped and cuts it where
     the box ends (`wrap: false`), as CoreText already did.
176. **Kept whole, a word showed two faults the cutting hid.** A word too
     long for the room beside a float stayed there when a space followed
     it, running over the float, where a line with no room for its first
     word moves down past the floats (CSS 2.1 9.5): a line that ended on
     white space was taken to have fitted, which was true only while
     every word was cut. And two `nowrap` elements with a collapsed space
     between them ran on as one word, where the break between two
     characters is the call of the nearest element holding both (CSS Text
     3, 5.1), and that is the paragraph.
177. **A `nowrap` element broke at its hyphens.** Its spaces were held as
     no-break spaces, and nothing held its other breaks: Tailwind's
     `whitespace-nowrap` on "state-of-the-art" broke after "the-". ntk
     8.13.0 has no break inside or between spans that share a `nowrap`,
     and each such element's text shares one, itself — so two of them
     side by side still break between them, as the rule above has it.
     CoreText has no such option, and on macOS the hyphens break as they
     did.

     `css-text`: 568 of its 1,489 tests passed on X11, 606 do now. It
     loses four that passed with every word cut: two that want
     `hyphens: auto` to hyphenate, which needs a dictionary nothing here
     has, and two whose `break-spaces` wants a break between two
     ideographic spaces, which the engine does not make.

### Round 77

178. **`visibility: collapse` took nothing out of a table.** It was read
     as `hidden`, so a collapsed row or column kept its room and drew
     nothing in it. CSS 2.1 17.5.5 takes it out: the row is as tall as
     nothing and the column as wide, with no spacing after either, and
     the table is that much smaller, a table with a width of its own
     too. Neither changes anything else: they size the table with the
     rest, and their cells are laid out at the widths they would have
     had, so no row is taller or shorter for a column taken out. A row's
     cells inherit the value and are not drawn; a column is no ancestor
     of its cells, so one wholly in columns taken out is left out of
     the paint (`COLLAPSED_CELLS`).
179. **A cell spanning a collapsed column is clipped to the ones left.**
     It is laid out across all of its columns, moved left by the width
     of the ones taken out before the first left in, and clipped to the
     rest (`CLIPPED_CELLS`), which cuts out what was in them; a cell
     spanning a row taken out is cut at the last row left. The spacing
     after a column taken out goes from the end of the content, which
     does not line up with the columns it spans. `column-visibility-004`
     passes, where all four browsers on wpt.fyi fail it: Chromium draws
     the collapsed column's part at the first column left.
180. **A row was as wide as its table**, the spacing round the cells
     included, where in the separated borders model its edges are its
     first and last cells' (CSS 2.1 17.5.1), and a row group's its
     rows'. An outline on a `<tbody>` stood a spacing out on either
     side, and a row's background image was placed against the wider
     box.

     `css-tables`: 83 of its 167 reftests passed on X11, 86 do now.

### Round 78

181. **The generic `monospace` was as large as every other family.** A
     browser keeps two default sizes, 16px and a "fixed" 13px, and the
     smaller one is the generic `monospace`'s when it is the whole of
     the family list — which is why a `<pre>` in a browser is 13px: an
     element whose family becomes it scales the size it inherits by
     13/16, one that leaves it scales it back, and a keyword size is
     read from the smaller scale, while a size an element sets itself
     stays its own (Blink's `CheckForGenericFamilyChange`). A list with
     another name in it keeps the size, so `monospace, monospace` is 16
     pixels, as authors who know the rule write it to get. The monospace
     tables of `table-anonymous-objects` were as wide as the page at 16
     and wrapped in their reference, which a browser lays out at 13.
     The UA sheet's own `<pre>` and `<code>` set their size, `0.9em` of
     the theme's, and are not moved by it.

### Round 79

182. **White space beside what a table wraps in a cell was dropped.**
     CSS 2.1 17.2.1 drops white space only between two of a table's
     parts, or beside one at an end: beside an inline box that the
     fix-up wraps in an anonymous cell it is that cell's, so
     `<span>a</span> <span>b</span>` in a `display: table-row` is a cell
     of `a b`, as it is loose in a table. It was dropped from both, and
     the words ran together. Firefox keeps it, and on wpt.fyi alone
     passes `table-anonymous-objects-085` and `-086`; Chrome, Edge and
     Safari drop it, as this did.
183. **An empty caption set to a width did not widen its table.** An
     auto table is at least as wide as its widest caption (CSS 2.1
     17.4), and a caption's least width is the one it sets itself where
     it sets one — but it was measured by laying it out at no width,
     where one set to `100px` measured nothing, and its table was as
     narrow as its empty cell.

     `css-tables`: 88 of its 167 reftests pass on X11.

### Round 80

184. **A spanning cell's own width was not its columns' to share.** Only
     a cell of one column read its `width`; one spanning three columns
     set to 100px, with 20px between them, left them no wider than its
     content asked, and the content drew in 40. A width of its own is
     the least a cell is, spanning or not (CSS 2.1 17.5.2.2, step 1),
     and the spacing between its columns is part of it, room they need
     not find — so those three columns share 60.
185. **A spanning cell was shared out before the cells under it were
     seen.** The cells were taken in document order, so one in a first
     row was spread evenly over columns a later row's cells set, and a
     column one of them set to 5px took half of it. The cells of one
     column come first, then the spanning ones, the narrower spans
     first (step 3), and what a spanning cell adds goes to those of its
     columns with no width set, in proportion to their content — to all
     of them where every one has a width, and compared with their widths
     rather than their content alone, so a span over two columns set to
     100px each holds 200 without growing.
186. **A 90% cell and a 10% one came to more than their table.** A
     percentage was taken as the cell's content width and its padding
     and borders added on, so the two came to a hundred percent and
     their borders, and the table took the excess back from both,
     leaving them 8.8 to 1. A percentage is a share of the table the
     cell's padding and borders are part of, as browsers read it.
187. **A cell set to a width lost its content's least width.** Its
     `width` is weighed apart, and its content was measured by laying it
     out at no width and reading back the width it was laid out at,
     which for a cell set to one was its padding: a column set to 3% cut
     the word in it, where a table never goes narrower than its words.
     The content is measured as the content now, whatever the cell's
     width says.

     `css-tables`: 89 of its 167 reftests pass on X11.

### Round 81

188. **A corner four equal borders met at went to the one below it.**
     Collapsed borders are painted winners last, so a corner goes to the
     strongest border meeting there, and between two that won alike the
     one painted later took it — the one found later, which was the one
     below the corner. The rule between two borders on one segment is
     the one further up and further left (CSS 2.1 17.6.2.1), and the
     corner follows it now: in a grid of equal borders each corner is
     its top-left cell's.
189. **A collapsed table's sides took their width from its first row.**
     CSS 2.1 (17.6.2) sets the table's left and right borders from the
     first row's outer cells, and a later row's wider one spills into
     the margin, outside the table — and outside its background, which
     the cells over it showed through. CSS Tables 3, and browsers, take
     half the widest along each side, as this already did at the top
     and the bottom.

### Round 82

190. **`empty-cells` did nothing.** With `hide`, a cell with nothing in
     it draws no background, of its own or of its row, its column or
     their groups, and no borders, where borders are separate (CSS 2.1
     17.6.1.1); the table's background shows through. A cell holds
     something when anything is in its flow — an empty element or a
     float among it — but not white space collapsed away. Collapsed
     borders are the grid's, and it leaves them be. What CSS 2.1 adds
     for a row whose every cell is empty and hidden, that it takes no
     height, is not done.

### Round 83

191. **A collapsed border on a line between two pixels started a pixel
     late.** A border is centred on its grid line, and the grid line
     was rounded before the border's whole half was taken off it: a
     line at 12.5 with a 25px border drew it from 1 to 26, and the cell
     under it showed a pixel wide at the table's edge. It is drawn from
     the line less half its width, rounded there, 0 to 25, as browsers
     place it. At 2x the half pixel is a whole one, and Cocoa had it
     right already.

### Round 84

192. **An image told to be a table's part was laid out as a block.** A
     replaced element takes no layout-internal display: one set to
     `table-cell`, or any `table-*`, is inline (CSS Display 3, 2.4). The
     table fix-up already saw that it was no cell and wrapped it in an
     anonymous one with what was beside it, but inside that cell, and in
     a block, it was a block: two such images stood one above the
     other, and the white space between them collapsed away as between
     two blocks. The box builder, the white space pass and the inline
     layout now all read it as an atomic inline, as an `<img>` is.

### Round 85

193. **A cell with a height of its own kept its content at the top.**
     `vertical-align: middle`, which HTML gives every cell, moves a
     cell's content in the cell's box, and that box can be taller for a
     height the cell sets as well as for a taller cell beside it. The
     set height was taken for content, the content was as tall as the
     box already, and there was no room to move it: a `<td height>`
     kept its text at the top, where every browser centres it. The
     content's own height is kept apart now, and aligned in the box.

### Round 86

The runner read XHTML's style sheets raw, as HTML does, where a browser
reads them as XML and decodes their entities: 106 of the suite's files
have one in a style sheet outside CDATA, most of them a combinator written
`&gt;`, and every rule with one was dropped — from a test and from its
reference alike, so that a pair that both lost their rules matched
whatever `<Html>` did with them. The runner now decodes them first. Eight
tests pass that could not, the `inline-table` and `inline-block` stacking
tests among them. Six that passed by that accident are compared for real
now: two showed the case folding below, and pass again; the four
`text-indent-intrinsic` tests showed the indent below, and fail still, as
they set a `<pre>` beside their floats and the user-agent sheet's own
`<pre>` has padding.

194. **A pseudo-class's name folded Unicode's case, not ASCII's.** CSS
     matches the names of pseudo-classes, and a `:lang()` argument,
     without regard to ASCII case alone (CSS 2.1 4.1.3), and Unicode's
     lower case makes a Kelvin sign a K: `:lin\212A` was taken for
     `:link`, and `:lang(\212Al)` matched `lang="kl"`. Both are read
     with ASCII's case now, and a name with a letter from anywhere else
     is no pseudo-class, and drops its rule.
195. **A first line's indent made it look full.** A line keeps whatever
     comes first on it — there is no break before it — and a first
     line's `text-indent` is room it takes, not content; but an
     inline-block measured against the room after the indent went to a
     second line where it did not fit, leaving the first line empty. At
     a float's least width, that was a float as wide as the
     inline-block, without the indent.

     `css-text`: 607 of its 1,489 tests passed on X11, 610 do now.

### Round 87

196. **A document's `<meta http-equiv="content-language">` said nothing.**
     HTML makes it the language of whatever no `lang` covers — the
     pragma-set default language: the last such `<meta>`'s `content`, up
     to its first white space, and none where it lists more than one —
     and `:lang()` read only the attributes. It falls back to the
     document's now, found once per document, and searched from the
     document itself, where in a fragment the `<meta>` is a sibling of
     what it covers. A `Content-Language` HTTP header, the rung below,
     is the host's to know, and is not read.
197. **`[title~=]` was a selector.** An attribute selector's operator
     needs a value; without one the selector is invalid and takes its
     group with it (CSS 2.1 4.1.7), and a rule written
     `[title~=], p.valid` coloured `p.valid`. And `[title~=""]`, which
     represents nothing, since no word of a list is empty, matched a
     title of spaces: the matcher's `~=` took the empty word for the
     one between two spaces, and is handed a selector that matches
     nothing in its place.

### Round 88

198. **A `<q>` had no quotation marks.** HTML's rendering puts them there
     with `q::before { content: open-quote }` and its close, and the
     user-agent sheet did not have the rule, though `<Html>` has had
     `open-quote`, `close-quote` and `quotes` since round 2: a
     quotation was bare, and a nested one no different. They take the
     `quotes` in force, so `q:lang(fr) { quotes: "« " " »" }` gives a
     French one its guillemets. No CSS 2.1 reftest has a `<q>`;
     `css-content`, which has six, passes 16 of its 63 where it passed 10.

### Round 89

199. **An absolute box a `max-width` held stayed at its start edge.**
     With both offsets and `width: auto`, the box fills what they leave,
     its `auto` margins nothing (CSS 2.1 10.3.7, rule 5) — but a
     `max-width` or `min-width` that moves that width makes one like a
     width set, and the rules run again with it (10.4), where two `auto`
     margins share what is left: the box is centred. The width was not
     held back at all, and a box set to `max-width: 100px` between
     `left: 8px` and `right: 8px` ran the page's width; held back, it
     stayed at the left. It is clamped, and centred. The same goes
     for the height between `top` and `bottom` (10.6.4, 10.7), where
     `max-height` held it back and the margins stayed at nothing, so a
     box meant to sit in the middle sat at the top.

### Round 90

On ntk 8.13.1 and react-x11 2.22.11, where master passes 5,554 on X11 and
5,031 on Cocoa.

200. **An image set `vertical-align: middle` was centred in its line.**
     CSS 2.1 puts its middle half the parent's x-height above the parent's
     baseline (10.8.1). The middle of the line is somewhere else whenever
     the line is taller than its text, which an image taller than the text
     makes it on its own: beside a 30-pixel image, 15-pixel Ahem sat a
     pixel and a half higher than CSS puts it, which `c544-valgn-001` and
     three of the `c44-ln-box` tests show. An image or an inline block now
     takes its raise from its parent's baseline as an inline box does:
     `sub` and `super` by the parent's font size, where they went by the
     line's height, and `text-top` and `text-bottom` to the parent's font,
     where they were the baseline. A face that states no x-height — an
     OS/2 table older than version 2, as DejaVu's is — is taken at half an
     em, as `ex` already took it: the engine answers NaN for it, and an
     image or an inline box set `middle` was raised by that.
201. **`text-transform: capitalize` capitalized the first character after
     a space**, and the first of every text, in upper case. So `(p.p.)`
     stayed as it was, its bracket "capitalized"; a word an element's edge
     crossed — `<b>fo</b>o` — got a second capital after the edge; and `ǆ`
     became `Ǆ`. The first letter or number of each word is in title case
     now, which for a digraph is `ǅ` and for a Greek vowel keeps its iota
     subscript, and a word runs on across element edges as white space
     collapses across them. What joins letters into one word is UAX #29's,
     as the spec suggests — `x.y`, `don't` — and a hyphen or a bracket is
     between words. Chrome splits `x.y` and `a:b` too.
202. **A `::before` or `::after` set `display: list-item` had no marker.**
     It counted the `list-item` counter, as an element does, and drew
     nothing for it. It has the marker an element has, outside, or at the
     start of its content where it is `inside`.
203. **Text beside a block in an anonymous table cell was never laid
     out.** The fix-up works from the leaves up, so a cell the table
     part of it makes has children that were fixed as the table's, and
     the cell itself never had the block container's turn: `bcd` beside a
     block in `<span style="display: inline-table">` was text a block
     container held beside a block, which lays out as nothing, and the
     table was as wide as the block. The cells it makes have their turn
     now.

### Round 91

204. **A table cell was no taller than the height it set.** Its content is
     laid out as a block's, which keeps a height it sets and lets the
     content run out, and a cell does not: the height is a least one (CSS
     2.1 17.5.3). `<td height="10">` with a line in it is as tall as the
     line.
205. **A cell, a row and a row group took margins, and rows their
     padding**, which CSS 2.1 applies to no part of a table but the caption
     (8.3, 8.4): a cell set `margin: 50px` left a gap in its table. The
     values are still theirs, for a cell's `inherit`; they do nothing.
206. **A cell's `min-width` and `max-width` did nothing.** CSS 2.1 leaves
     them undefined on a cell, and every browser holds the cell's width
     within them, as this does a column's.
207. **Ten floats of `0.87em` in a box `8.7em` wide did not fit.** The
     widths add up to more than the room by a rounding error, and the tenth
     went under the other nine; a float fits in room short of it by less
     than a millionth of a pixel.
208. **`text-decoration` with a word it does not know kept the words before
     it**: `underline overline line-through diagonal` drew a line through,
     where the whole declaration is invalid (CSS 2.1 4.2). It is read whole
     first, and a line named with another is drawn with it, where the last
     one named was the only one.
209. **The runner served a style sheet whatever its type.** WPT's server
     sends `plaintext.css` as `text/plain`, as its `.headers` say, and a
     `.txt` file as that; a browser ignores either as a style sheet in a
     document in standards mode, and the runner, standing in for the server
     and the host, now declines them (`content-type-000`, `-001`).

### Round 92

210. **The background of an inline box set `top` or `bottom` was drawn on
     the line's baseline**, not its own. The text went where the line's
     edge put it and the background stayed behind, so in a line made taller
     by its paragraph the box sat a pixel or two off its text: in
     `content-174`'s reference, and `padding-applies-to-017`'s and
     `floats-124`'s, which is one file. Each such box's baseline is kept for
     the line it is on, which is a different height on every line.
211. **A line's inline box whose padding reached up over the line before
     was drawn under that line's text.** CSS 2.1 Appendix E paints a block
     a line at a time, backgrounds before text, so the box covers it. The
     ink here goes on in one batch after every line's backgrounds, for its
     speed, so the part of such a box above its own line is drawn again
     over it, and nothing is drawn again where no box reaches up
     (`border-padding-bleed-001` to `-003`).
212. **The `font` shorthand's size won over a more specific `font-size`.**
     The cascade takes the font first, so that an `em` in the rest of a rule
     is the element's own, and then applies everything else in order again
     but `font-size` — the `font` included, for its other longhands, and so
     its size too: `span { font: 15px/1 Ahem }` under `.b > span {
font-size: 3.75em }` was 15px, its `em`s 3.75 of its parent's. The size
     is the first pass's now (`c43-rpl-bbx-002`, `c43-rpl-ibx-000`,
     `c42-ibx-ht-000`, `c5506-ipadn-t-000`). Five `text-fit` tests in
     css-text had passed on it: their references write `font: 10px Ahem`
     and then `font-size: 20px`, and rendered at the 10px their tests,
     which `text-fit` would enlarge, are drawn at.
213. **`letter-spacing` took no percentage**, which CSS Text 4 makes one of
     the font size (`c542-letter-sp-001`).
214. **An image told to be a column or a column group was taken for one**
     and never drawn; it is an inline image, as one told to be a cell is
     (`outline-applies-to-016`, `-017`).

### Round 93

215. **An absolute box among a paragraph's text took the paragraph's top
     for its static position**, and was drawn over the text before it. A
     block-level one goes under the line that text is on, which it would
     have broken, and an inline-level one where the text left the pen: on
     that line, or under it after a `<br>` (`abspos-block-level-001`,
     `abspos-inline-007`, `hypothetical-inline-alone-on-second-line`, and
     `abspos-007` on Cocoa, which X11 misses by five pixels: a descender
     reaches a row past its line there, and the box covers it). The
     position is found from the text before the box once the lines are
     made, whichever of the four ways they were made: a paragraph laid out
     in one call to the engine, or around a padded span, never met its
     absolute boxes at all.
216. **An absolute box inside a `position: relative` inline box was placed
     against a rectangle of no size at the page's corner.** An inline box
     lays nothing out of its own, and was read as a box that does; its
     containing block is now the padding boxes of its fragments on the
     lines, from the start of its first to the end of its last (CSS 2.1
     10.1, `abspos-float-with-inline-container` on Cocoa, which X11 misses
     by a row: the content area starts a fraction of a pixel under the line
     there, and a browser rounds that fraction down). A tooltip set under a
     positioned link was drawn at the top left of the document.
217. **A page with a `<body>` and no `<html>` lost its `html { … }`
     rules.** htmlparser2 parses what it is given, and a page that starts
     `<!DOCTYPE html><title>` has no `<html>` element for a rule to match.
     The root box stands in for the one a browser implies, as it already
     did for a fragment with neither, so `html { font-size: 10px }` reaches
     the body (`abspos-negative-margin-001`, with 215).
218. **A no-break space beside a block was dropped as white space.**
     JavaScript's `trim` and `\s` take in U+00A0 and the other Unicode
     spaces, and CSS's white space is the space, the tab and the line
     breaks alone. Nine places asked the first whether a text was blank,
     so the `&nbsp;` a mail layout holds a gap open with vanished beside a
     block, in a flex box and in a grid, as if it held nothing
     (`between-float-and-text`, `vertical-align-baseline-004a`, `-005a`).
219. **A shrink-to-fit box that does not wrap was cut to its room.** Its
     least width was bounded by its widest word, and a `nowrap` line has no
     place to break, so the whole line is the word: a `nowrap` tooltip
     under a link narrower than it was the link's width, the rest of its
     line out of its background. No test in the suite has one.

### Round 94

220. **A positioned box inside a box painted whole was painted with it.**
     CSS 2.1 Appendix E has a stacking context paint every positioned box
     in it after its flow, in document order and then by `z-index`,
     whatever box it is in. Here each box painted its own positioned
     children after its own flow, so the ones in a box painted whole — one
     that clips, a float, a table, a flex box, a positioned box with no
     `z-index` — were painted with it, among the flow around it: a box
     absolute in an `overflow: hidden` one went under a positioned box
     before it (`static-inside-inline-001`, `-003`), a relative box in a
     float under the text after the float (`floats-154`) and one with a
     `z-index` under a relative box after it (`floats-041`), and a menu
     with a `z-index` in a positioned header under the positioned content
     after the header. The stacking context gathers them once a layout,
     from the subtrees that hold any, and a box painted apart from the
     boxes around it is under the clips of the ones between that hold its
     containing block, as it was where its parent painted it.
221. **A line holding an inline box's margin and border that add up to no
     width was no line.** CSS 2.1 9.4.2 gives a line with no text no height
     unless an inline box on it has margin, border or padding — any of
     them, whatever they come to — and a block-level absolute box after
     such a box goes under its line (`static-inside-inline-002`).

### Round 95

222. **A block that cleared a float placed before anything fixed where its
     parent's content goes had its margin above the float.** Such a float
     would go down with a margin collapsing up through the parent's top
     were `clear` none, so the block is never below it there: it always
     has clearance, and its border edge goes under the float whatever its
     margin, which may take it back up (CSS 2.1 9.5.2, as the browsers read
     it; `adjoining-float-before-clearance`, `adjoining-float-new-fc`,
     `adjoining-float-nested-forced-clearance`,
     `negative-clearance-after-adjoining-float`). A float after content
     does not move with the margins after it, and a block that clears it
     is where its margin puts it when that is below the float, as before.
223. **A cleared block whose margin took it past the floats parted its
     margin from its parent's** as if it had clearance: with none, nothing
     parts them, and the margin goes on up through the parent's top, which
     it moves (`no-clearance-due-to-large-margin`). A `clear` with no float
     to clear is no clearance either.
224. **A border shorthand that named a part twice took the second**: `red
solid 16px red` is invalid, each of the three at most once
     (`shand-border-001`). A token the parser does not know still leaves
     the rest, for a colour syntax it does not read yet.
225. **An empty inline box's line height made its line no taller.** Every
     inline box is on its line as tall as its own line height, text or
     none (CSS 2.1 10.8), and one with no text is given no room by the
     engine, which lays out text: an empty `<span>` of taller lines before
     the text, or the last piece of a large-faced box a block was split
     from, was on a line as short as the paragraph's — the empty span on a
     line of its own after the text, its edges having taken no room. A
     line of nothing but empty boxes stays no line (9.4.2), unless one has
     a margin, border or padding, whatever they add up to
     (`empty-inline-003`, `margin-right-114`, and
     `inline-formatting-context-023` on Cocoa).
226. **`initial` left a property as it was**, which an inherited property
     had from its parent and any property from an earlier declaration:
     `line-height: initial` in a block inside a box of 200px lines was
     200px (`split-inline-borders`), and in css-cascade
     `initial-background-color`, `initial-color-background-001`,
     `unset-val-001` and `-002`. It is the property's initial value now,
     and `unset` on a property that does not inherit is too.

### Round 96

227. **A table set shorter than its rows was as short as it was set.** A
     table's height is a least one (CSS 2.1 17.5.3), which the table layout
     shares out to the rows; the block layout then took the set height for
     the table's own, which ended its background over the rows and let a
     float after it go up beside them (`floated-table-wider-than-specified`).
228. **A float was held to its containing block always.** CSS 2.1 9.5.1
     keeps a left float short of the right floats beside it (rule 3), and
     within its containing block only where a left float is beside it too
     (rule 7); a float wider than its block went below every float beside
     it, where it fitted beside them in the formatting context
     (`floats-rule3-outside-left-001`, `-right-001`).
229. **A `<canvas>` took no room.** It is a replaced element the size of
     its bitmap, which its `width` and `height` attributes give, 300 by 150
     where they do not, and it keeps their proportions (HTML 4.12.5); the
     attributes were taken for size hints, as an image's are, so one set a
     height kept no width. No script draws in it here, so it is a box of
     its size with nothing in it, as an `<iframe>` is
     (`intrinsic-size-with-anonymous-block`, and `vertical-align-122` on
     X11).
230. **A box on a line set below the flow was drawn twice**, by its
     stacking context below the flow and by its line after it, and so over
     the box it was set under (`intrinsic-size-with-anonymous-block`).
231. **A fixed box was no stacking context without a `z-index`.** A fixed or
     sticky box is one whatever its `z-index` (CSS Positioned Layout 3, as
     the browsers paint it), so a box in it set to `z-index: -1` is drawn
     over its background, where it went behind the page
     (`fixed-pos-stacking-001`).

### Round 97

232. **A line an image set `top` made taller had its text halfway down
     it.** Where the baseline goes in a line a `top` or `bottom` box made
     taller than the rest is left open (CSS 2.1 10.8.1), and it was centred
     in the room the box left. Browsers keep it where the rest of the line
     puts it, under the line's top, and only a `bottom` box taller than the
     rest moves it down: Gecko's rule, which needs no order between the two
     (`clear-inline-001`, `floats-029`, `vertical-align-121` and two
     `::first-line` tests, whose references set text beside a `top`
     image).
233. **A collapsed border was drawn half a pixel early.** Layout split a
     border between two rows a whole pixel to one side, where browsers
     split it half and half; paint centred it on the line all the same,
     and rounded the table's place and the line's offset apart, so a
     pixel's border between two rows was drawn a pixel into the row above
     (`block-formatting-contexts-003`). The halves are exact, which moves
     no cell's content — the two always come to the border — and the
     border is placed on the page and rounded once there.
234. **A line took its room beside the floats over a guessed height.** The
     room was measured over 1.4em, a line of text's, whatever the line
     held, before its height was known: a line of `line-height: 0` holding
     a 20px inline-block went below the floats that start 20px down, where
     it fitted beside the one at its top (`floats-placement-003`). It is
     measured over the paragraph's strut, and over an item's own height
     where that is taller, as before. The 1.4em held no test up.
235. **The canvas missed a `<body>` in an `<html>` set to be a table.** The
     body is in an anonymous row and cell there, and only the root's
     children were looked at (`abspos-containing-block-initial-004e`,
     `-004f`).
236. **A text field the author gave a border or a background had the
     theme's drawn over them.** A browser drops a field's native look for
     the author's (CSS UI 4, `appearance`), and the widget was mounted over
     the whole box with its own frame and fill. The document paints the
     field's box now, and the widget goes bare in its content box, in the
     element's colour and font, which the author chose for that
     background; its size is its text's, the border and padding around it
     the author's (`blocks-026`). A button keeps the theme's look: core's
     `<Button>` draws its own label, and a page's button is its own round.

### Round 98

237. **Margins of both signs collapsed two at a time.** CSS 2.1 8.3.1
     collapses a set of adjoining margins to the largest positive one
     plus the most negative, and summed at each join that is not
     associative: 2, -4, 0, 14, -4 and 2 are 10, and two at a time 8. The
     margins are kept as a strut now, the two apart, through the walk
     that collapses a box's top margin, the margins left hanging between
     siblings and the one that comes out through a box's bottom
     (`margin-collapse-111`, `-135`, `margin-bottom-103`, `-104`,
     `abspos-022`).
238. **Clearance was decided from a box's own margin, and never went
     up.** A cleared box's place without clearance is where its margin
     and every one that collapses up through its top put it, and a large
     margin inside it takes it past the floats with no clearance at all
     (`no-clearance-due-to-large-margin-after-left-right`). With
     clearance, its border edge goes under the floats whatever its own
     margin, which may take it up: the clearance is negative
     (`negative-clearance-after-bottom-margin`). And the block after an
     empty one with clearance starts at that one's edge where the margins
     they collapse to come to no more than its top margin, which is above
     the edge (`margin-collapse-125`).
239. **A new formatting context beside floats.** Where a float narrows
     the room, a negative margin takes the box no further out than its
     containing block's edge, as every engine has it
     (`zero-width-floats-positioning`); the suite's
     `floats-wrap-bfc-with-margin-006` and `-007` propose otherwise, pass
     in no browser, and are lost. And what may not overlap a float is the
     box's border box, from its top: taken as tall as its margins, a box
     a negative top margin took up missed the float it then overlapped
     (`floats-wrap-bfc-with-margin-010`'s boxes, whose reference, a
     positioned `<body>` standing in as the root, still comes out 8px off).
240. **Floats and the line they are met on.** A float after one that
     waits for the next line waits too, since none goes higher than one
     before it (`floats-placement-vertical-003`). And a float met inside
     text that may not break there — a `nowrap` element, or a word — is no
     place for the line to break: the line keeps room for the text after
     the float up to where it may, or breaks before the word it is tied
     to (`floats-line-wrap-shifted-001`, and `float-nowrap-9`, which only
     Firefox passes).
241. **A column set to a width is that wide.** Browsers take a set width
     on a cell or a column for the column's, which its content widens only
     where it cannot break narrower; CSS 2.1's step 2 took it for a floor
     under the text's widest line (`vertical-align-baseline-003`, and
     `c5501-mrgn-t-000` and `c5503-mrgn-b-000` on X11). And a table of no
     cells is as wide as its caption can be, as one with cells is at the
     least, where it was the width of the page (`vertical-align-baseline-009`).
242. **`<map>` was `display: none`.** It is inline (HTML 15.3.1), and an
     `<area>` in it an author gives a display is drawn (`content-100`).
243. **An anonymous block after a block took the `text-indent`.** Only an
     element's first formatted line is indented (CSS 2.1 16.1), and an
     anonymous block's is that only where it is its parent's first child:
     the text after a `<div>` inside a `<span>` started indented
     (`block-in-inline-first-line-002`, `text-indent-014`).
244. **An outline under an inline-block after it.** An in-flow block's
     outline was drawn after its own lines, so a later line's
     inline-block went over it. Outlines are drawn after all of the
     flow's lines and under its positioned boxes, as browsers draw them
     (`z-index-020`, which allows either of CSS 2.1's two orders).

### Round 99

245. **`text-align-last` was not read.** The lines the end of a text or a
     forced break ends are aligned as it says (CSS Text 3, 7.2), and a
     text that does not wrap is all such lines. Where they are aligned
     otherwise than the rest and neither is justified, the lines are made
     one at a time, each aligned its own way; where the rest are
     justified, they fill their width whatever the alignment, and the
     paragraph stays one layout. `text-align: justify-all` justifies the
     last line too, and `text-justify: none` justifies nothing
     (`block-in-inline-align-last-001`, and css-text 611 to 643).
246. **An unquoted family name kept its spacing.** `Courier    New` over
     two lines, or with a tab, is `Courier New`, identifiers joined by one
     space (CSS 2.1 15.3); kept as written, it was a name no font has
     (`font-family-011`).
247. **A line height below nought was taken.** It is no line height, and
     the declaration goes (10.8.1): `line-height: -2` stood the lines on
     one another, and `font: 4em/-2em serif` set the text at 4em where the
     whole shorthand should have gone (`c548-ln-ht-002`, and `font-146` on
     Cocoa).
248. **Two text-engine faults, filed and fixed upstream.** A letter the
     first family lacks was set in whichever registered face came first
     rather than in the next family the style names, and a word shaped
     under one family list answered the same word under another
     (sidorares/ntk#433); and `font-kerning: none` still kerned a face
     that keeps its pairs in the older `kern` table, Times New Roman's
     (sidorares/ntk#431). With both, `font-family-013`, `fonts-013` and
     `clear-applies-to-008` pass on X11.

### Round 100

249. **ntk 8.14.1**, which carries the two fixes of item 248: the lockfile
     moves to it, and the three tests pass on X11. Cocoa's text is
     CoreText's, which kerns and falls back as browsers do already.

### Round 101

The CSS 2.1 suite has no `line-clamp`. css-overflow went from 145 to 263
of 639 on X11, every test of it a line-clamp one, and css-overflow and
css-values together from 187 to 335 of 852 on Cocoa.

250. **A clamp counted only its block's own lines.** `line-clamp` makes a
     block a line-clamp container (CSS Overflow 4, 5.3.1), whose count runs
     through the blocks of its formatting context: Tailwind's
     `line-clamp-3` on a card whose text is in paragraphs clamped none of
     them, the card having no lines of its own. The lines are counted as
     the flow is laid out, and a box of a formatting context of its own
     counts as a block. The boxes after the clamp point are invisible, take
     no room and are not laid out; a positioned box among them shows where
     its containing block does. The last line ends in an ellipsis where the
     clamp cut the text or more of the container follows it, and in none
     where the content ends with it, or only a phantom line follows.
251. **`-webkit-line-clamp` clamped any block.** It clamps only a
     `display: -webkit-box` whose `-webkit-box-orient` is vertical, which
     is then a block of its own formatting context (5.1.1, 5.3): written
     alone, as stylesheets carry it, a browser shows every line. A
     `-webkit-box` that does not clamp was a block, and is a flex box in
     its orient's direction, packed, aligned and flexed by the
     `-webkit-box-*` properties, as Blink lays one out. `line-clamp` on a
     multicol container does nothing (5.2).
252. **The ellipsis cut a word.** The engine's ellipsis, the one
     `text-overflow` asks for, takes its room from inside the line's last
     word; a clamp's goes after the words that fit beside it, and the rest
     go to the lines it hides (4.2). The last line's text is broken again
     in the room the ellipsis leaves, cut inside a word only where the line
     has one, and the ellipsis is set in the block's own style.
253. **`line-clamp: auto`** shows as many lines as the box's `height` or
     `max-height` holds (5.3.1): the flow is laid out whole once to count
     them, each with what closes below it — the bottom padding, border and
     margin of the blocks around it — and again cut after them.
254. **`lh` and `rlh` were not read.** A length in them is the element's
     computed line height, or the root's, `normal` as its font's own (CSS
     Values 4, 6.1.1). Where a sheet has one, the line height is settled
     ahead of the declarations that read it, with this element's `em`; the
     `max-height: 4lh` most of css-overflow's `line-clamp: auto` tests size
     their box with was no height at all.

### Round 102

The CSS 2.1 suite has neither; css-sizing went from 230 to 245 of 562 on
X11.

255. **`fit-content()` was no width.** `width: fit-content(100px)` — and
     `min-width` and `max-width` of it — fits the content in the room its
     argument makes (CSS Sizing 3, 3.1): no wider than the content at its
     widest, nor narrower than its longest word, a percentage being of the
     containing block. The argument is a width of the box's own, its
     padding and border outside it where `box-sizing` says so.
256. **A box with a width measured its content at the probe's width.** The
     content's intrinsic sizes that `min-width: min-content` and its kin
     are made of were measured by laying the box out at no width at all,
     and a box with a `width` of its own answered with that, which was the
     probe's nought: `width: 10px; min-width: min-content` was 10px wide
     where its longest word is wider. They are the content's now, whatever
     the box's own width (`min-content-min-width-000`,
     `shrink-to-fit-sizing-max-width-min-content`). A percentage inside
     `fit-content()` measured for a parent's intrinsic size, which CSS
     Sizing 3 treats as cyclic, is still resolved against the probe's
     width.

### Round 103

257. **A word was shaped a span at a time.** ntk 8.14.2 shapes a word that
     runs across spans shaped alike as one (sidorares/ntk#438): kerned
     across a `<span>`'s boundary, and in Arabic joined across it, as CSS
     Text 3 (7.3) has it and browsers shape it. The text of an inline box
     with a margin, border or padding at a side is shaped on its own, as
     CSS breaks shaping across the edge — at both of its sides, which is
     one more than CSS asks of a box with an edge at one; the engine
     parts a span from both of its neighbours or neither. CSS 2.1 went
     from 5,649 to 5,651 (`generated-content`), css-content from 16 to 29
     of 63 (its quotes) and css-text from 644 to 656 (shaping,
     `text-transform`, `boundary-shaping`).

### Round 104

The CSS 2.1 suite has few flex boxes and none of these; css-flexbox went
from 564 to 585 of 1,012 on X11, css-grid four more, and css-flexbox and
CSS 2.1 together 19 more on Cocoa.

258. **`order` was read and never used.** Flex items are laid out in
     `order`, and in the document's where two have the same (CSS Flexbox
     5.4) — Tailwind's `order-first` and `order-last` — and an `order`
     that is no integer is dropped (`flexbox_order`, `flexbox_rtl-order`,
     `flexible-order`, `order-with-row-reverse`).
259. **Items aligned by their baselines were lined up by their bottoms.**
     Yoga has no baseline for an item it measures, and takes a leaf's
     bottom edge for one. With the items laid out, each line's items
     aligned by their baselines are set at its start with the margins that
     line up their first baselines, and the flex layout runs again, so the
     line is as tall as that makes it, and the lines after it and the
     items across it are placed by it (`flexbox-align-self-horiz-001`,
     `flexbox_align-items-baseline`).
260. **A flex box sat on its last line box's baseline**, as an inline
     block does. Its baseline is that of the first item on its first line
     aligned by its baseline, or of its first item, in `order` (CSS
     Flexbox 8.5), and an item with none gives its border box's bottom
     edge. A grid whose items have none falls back to its own box (CSS
     Grid 1, 9), as it did (`flexbox-baseline-multi-item-horiz-001a`, and
     four of css-grid's alignment tests).
261. **Yoga dropped a margin across a wrapped line.** In the pass Yoga
     takes for a flex box that wraps, or aligns by baselines, an item
     aligned to its line's start is set as though it had no margin at
     that side, and a centred one as though it had none at either (Yoga
     3.2.1): `items-start` in a wrapping row of cards put every card's top
     margin under it. Placement adds the margin back, and half the
     difference for a centred item; a column whose cross axis runs right
     to left is left as Yoga has it.
262. **`inherit`, `initial` and `unset` reached no flex or grid
     property**, 29 of them: `align-self: inherit` in the suite's flex
     boxes was `auto`.

### Round 105

263. **A flex item's `z-index` did nothing unpositioned, and `order` did
     not reach paint.** A flex item paints as an inline block does, in
     `order`, an absolutely positioned child among the items at 0, and a
     `z-index` makes it a stacking context whether or not it is positioned
     (CSS Flexbox 5.4), a negative one under its context's flow; a grid's
     items the same. css-flexbox went from 585 to 590 of 1,012 on X11
     (`flex-item-z-ordering`, `order-painting`), and css-grid 22 more (its
     items' z-axis ordering).

### Round 106

264. **A flex box was painted whole in its place**, as a table or a box
     that clips is, after every block's background in its flow. It is a
     block of the flow: its background and borders are painted with the
     flow's, in the document's order, and its items with the flow's lines,
     each whole, as inline blocks are (CSS 2.1 Appendix E) — a grid the
     same. A block after it that a negative margin drew up over it was
     covered by its background, which is how css-flexbox's tests hide their
     red: it went from 590 to 607 of 1,012 on X11 (`flex-shrink`,
     `align-self`, `flex-basis`).

### Round 107

265. **`justify-content: start` was the main axis's start.** `start` and
     `end` are the writing mode's, so a reversed row or column turns them
     round, and `left` and `right` are the page's along a row and `start`
     along a column, which has neither (CSS Box Alignment 3, 6.1): read as
     the main axis's own ends, `right` put a column's items at its bottom,
     and `start` a reversed row's at its right. `unsafe` is read past, as
     what an alignment does anyway, and `self-start`, `self-end` and
     `first baseline` are read; a `safe` alignment is still dropped.
     css-flexbox went from 607 to 619 of 1,012 on X11. One css-grid test
     passed by an accident this ends: a masonry `grid-lanes` box, which is
     laid out as blocks here, matched its reference grid only while
     neither read `unsafe`.

### Round 108

266. **A replaced flex item ignored the flex layout.** An image was
     measured as nothing wide — its content's width, and it has no
     content — and then laid out at its natural size whatever Yoga said:
     it did not grow, stretch or shrink. It is the size the flex layout
     makes it now, from its natural width along a row and fitted to the
     room across a column; it shrinks no further than its natural width,
     or what its ratio makes of a height of its own, within its least and
     greatest heights (CSS Flexbox 4.5); and one that a line of a
     definite size stretches takes its flex base size from the stretched
     size through its ratio (9.2, 9.8) — which Yoga's own `aspectRatio`
     would do for its border box, where a replaced element's ratio is its
     content box's. css-flexbox went from 619 to 639 of 1,012 on X11. One
     test passed by the accident this ends: Yoga grows an item from its
     basis within its least width, as Chrome 86 did, and an image of 1px
     with `min-width: 100px` beside a growing sibling comes out 149.5px
     wide where browsers now make it 100.
267. **`flex-basis: content` took a row item's width** for its basis, as
     `auto` does; it is its max-content width, or a replaced element's
     natural one, whatever width it has (7.2.3).

### Round 109

268. **An absolutely positioned child of a flex box or a grid was placed
     at the box's corner**, and against the box whatever its containing
     block was: one in a flex box that is not positioned took the flex
     box's padding box for its own. It is where it would be as the box's
     one item (CSS Flexbox 4.1, CSS Grid 1, 9.2): in a flex box's content
     box, set along the main axis by `justify-content` and across by
     `align-self`, and in a grid's padding box by `justify-self` and
     `align-self` — against its own containing block.
269. **A grid gave an absolutely positioned box no grid area.** The
     containing block of a box a grid positions is the area between the
     lines its placement names (9.1), and a line that is `auto`, is no line
     of the grid, or is only a `span` is the grid's padding edge — so
     `grid-column: 2`, whose end is `auto`, runs to the edge. A child of
     the grid is aligned in the area where its offsets are `auto`; a box
     deeper in the grid takes its percentages and offsets from the area and
     stays where its flow put it. css-grid's `abspos` tests went from 27
     to 73 of 150, and css-flexbox's from 21 to 26 of 32.
270. **`grid-template`, `grid` and `grid-auto-columns` were not read**, so
     a grid written with a shorthand had no tracks and stacked its items
     in one column. `grid-template` is rows, a slash and columns, the rows
     written as area strings each sized by what follows it or `auto`;
     `grid` the same, or one axis's tracks and the other's `auto-flow`
     size. The area names are not placed by, nor is `auto-flow` down the
     columns. The rows a template names are the grid's whether or not an
     item is in them, and `auto` rows share a height the grid has of its
     own, as `align-content: normal` stretches them (11.8).
271. **A grid item that does not stretch was cut to its area.** It is
     `fit-content`: as wide as its content fits, no wider than its area
     unless its longest word is (6.2).

css-grid went from 366 to 418 of 1,651 on X11, css-flexbox from 639 to
646, css-sizing from 246 to 252. Eighteen tests passed by the accidents
this ends. Nine `subgrid` and `grid-lanes` tests and
`grid-intrinsic-maximums` matched references written with the `grid` and
`grid-template` shorthands only while neither was read; three `safe`
alignments of an absolutely positioned box matched references that had
their boxes at the corner too; and five of css-break's grids in
multi-column boxes, which `<Html>` does not fragment, matched their green
squares only while the shorthands, the rows a template names and no item
fills, and the stretch of an `auto` row were not there to push their items
past the column.

### Round 110

272. **A grid's tracks were sized by rules of its own.** An item spanning
     several tracks grew the last of them by what it needed past them,
     whether that track was a length or not; the free space grew the
     tracks in proportion to what each wanted; an `fr` row was as tall as
     what was in it; and `fit-content()` was a max-content track with no
     limit. They are sized by the track sizing algorithm now (CSS Grid 1,
     11.3 to 11.8), the same for the columns and the rows
     (`layout/tracks.ts`). The items in one track set its base size and its
     growth limit, where its least is `auto` from what each item can be at
     least: its content's narrowest only where it shows what overflows it
     and spans no `fr` track beside another. An item spanning several
     shares out what it needs past them, equally as far as each track's
     limit and past the limits only to the tracks its content sizes, the
     fewest spans first. The free space then grows every track equally
     towards its limit, the `fr` tracks share what is left — a track whose
     content is more than its share frozen at it, and in a grid with no
     height of its own the `fr` that holds every track and every item,
     which fills its `min-height` — and the `auto` tracks stretch into what
     remains. A grid item's own length for a width is its size at any
     constraint: measured at no limit, it was its content's.
273. **`justify-content` and `align-content` did not place a grid's
     tracks**, nor `auto` margins its items. The space the tracks leave is
     before them, after them, between them or around each (CSS Box
     Alignment 3, 5.1), `center` and `end` running past the start where the
     tracks are larger than a height the grid has of its own; and an item's
     `auto` margins take the free space in its area before its alignment
     does (10.2). `justify-content: normal` is a value of its own, since a
     grid stretches its `auto` columns for it and not for `start`.
274. **Placement did not move its cursor past an item with a column**, so
     the next such item went in beside it rather than on the next row, and
     an item that named only its row was placed among the others in
     document order rather than before them (8.5).
275. **A stretched grid item was never shorter than what it held.** It is
     its area's height (10.3), so a main area that scrolls in an `fr` row
     is the row's height. An image, a control or a box with an
     `aspect-ratio` keeps its own height, as `normal` has one, unless the
     item's own `align-self` is `stretch`; and a `width` or `height` of
     `min-content`, `max-content` or `fit-content` is not stretched at all.

css-grid went from 418 to 450 of 1,651 on X11 and from 382 to 409 on
Cocoa, css-sizing from 252 to 256; the CSS 2.1 suite is unchanged. Eleven
tests passed by the accidents this ends: six of baseline alignment in a
grid, which `<Html>` does not do, matched their references only while an
item spanning two rows grew the last of them, and five `grid-lanes`
masonry tests matched theirs only while the same rules sized both.

### Round 111

276. **A grid's areas and the names of its lines were not read.**
     `grid-template-areas` names the areas its strings make — every name a
     rectangle, every row as wide as the first, or the declaration goes —
     and with it the lines at their edges, `<name>-start` and
     `<name>-end`; a track list names the lines between its tracks, a
     `repeat()`'s names repeated with it and those where two repetitions
     meet carrying both (CSS Grid 1, 7.2 and 7.3). A placement takes a
     name wherever it takes a number (8.3): alone it is an area's edge, and
     else the first line of that name; with a number, the lines of that
     name counted, the implicit lines past the grid counting as having it;
     and after `span`, the lines to the next of that name. A grid's
     explicit grid is as large as its areas as well as its templates. The
     shorthands copy a name to the lines they leave out (8.4). A bracket of
     two names, `[a b]`, was two words to the tokenizer, and the second was
     no size, so a template with one was dropped whole.
277. **`grid-auto-flow` was not read.** `column` fills the columns, and
     `dense` goes back to the start for each item, into a hole a wider
     item left (8.5).
278. **A percentage row in a grid with no height was `auto`.** It is
     `auto` to find the grid's height, and then a percentage of it, the
     rows sized again (7.2.1); and an `auto-fill` of rows counts its
     repetitions against the grid's height, as the columns' count against
     its width. `grid-gap`, `grid-row-gap` and `grid-column-gap`, the gaps'
     first names, are read.

css-grid went from 450 to 473 of 1,651 on X11 and from 409 to 432 on
Cocoa; the CSS 2.1 suite is unchanged. Six tests passed by the accidents
this ends: five `grid-lanes` masonry tests whose references are grids
with the names, the flow and the percentage rows this reads, and a
`subgrid` whose items flowed down one column only while `grid-auto-flow`
was not read.

### Round 112

279. **`object-position` did not move a stretched image**, the `fill` that
     is the default: with the box's size the image has no room to move in
     by a percentage, but it does by a length, and `right 2px bottom 1px`
     puts it two pixels in from the right and one up, cut to the box.
280. **An image with a ratio and no size of its own was stretched to its
     box** whatever its `object-fit` said: an SVG with only a `viewBox` is
     sized by the concrete object size rules (CSS Images 3, 5.2 and 5.5) —
     within the box or over it at its ratio, and for `none` its own size, a
     side it lacks from the other through its ratio, and with neither,
     within the box.
281. **An image was drawn at a fraction of a pixel** where its position
     came to one, and a background's tile at the pixel: a position of
     `13%` blurred it, and a pixelated image shifted a row. It is placed on
     the pixel grid as the tile is.
282. **A `<video>`'s poster and an `<embed>`'s image were not drawn**: both
     were frames with nothing in them. An `<embed>` whose `src` is an image
     shows it, as an `<object>` does, and a `<video>` shows its `poster`,
     which HTML's style sheet contains in its box (`object-fit: contain`,
     15.4.1). Where there is no image, both are frames as before.

css-images went from 132 to 262 of 470 on X11 and from 126 to 257 on
Cocoa, css-sizing from 256 to 258; the CSS 2.1 suite is unchanged on both.

### Round 113

283. **Past a dozen of them, every counter style was decimal**, and an
     `@counter-style` rule was skipped whole. The styles are written by the
     counter algorithms of CSS Counter Styles 3 (3.1) — cyclic, fixed,
     symbolic, alphabetic, numeric and additive, and `extends` — with their
     negative signs, prefixes, suffixes, ranges, padding and fallbacks, and
     every style the specification predefines is one of them (6, 7): the
     numeric ones of twenty-odd scripts, the kana, the CJK decimal and
     cyclic ones, Armenian, Georgian and Hebrew, `ethiopic-numeric`, and the
     Chinese, Japanese and Korean longhands. The Chinese longhands count
     past 9999 by the extended algorithm (7.1.2), as browsers do; the
     Japanese and Korean ones stop at it, as browsers do, and a Korean one
     falls back to decimal past it where its rule says `cjk-decimal`, as
     they all do. `@counter-style` defines a style, over a predefined one
     but the six that may not be, and `symbols()` an anonymous one; a
     name the specification defines is lower-cased and any other keeps its
     case. A `calc()` in a descriptor is the integer it rounds to, clamped
     to 0 where the descriptor takes no negative. `pad` counts grapheme
     clusters and the negative sign, so `decimal-leading-zero` writes -3 as
     `-3` where it wrote `-03`.
284. **A marker was its number, a full stop and a gap of 0.4em**, whatever
     its style. It is the style's prefix, number and suffix: a suffix that
     ends in a space is set off from the text by that space's width in the
     marker's face, and one that does not, `、`, is set against it; an
     inside marker's direction is its own (the HTML style sheet's
     `::marker { unicode-bidi: isolate }`) unless a `::marker` rule says
     otherwise.

css-counter-styles went from 46 to 209 of 248 on X11 and from 45 to 209
on Cocoa, css-lists from 120 to 124, css-pseudo from 55 to 58; the CSS
2.1 suite is unchanged on both. One test passed by the accident this
ends: `descriptor-calc` writes its descriptors with `sign()` of lengths,
which `<Html>` does not evaluate, and matched its reference only while
neither's `@counter-style` rules were read. The `-extended` tests of the
Japanese and Korean longhands fail in every browser too, and the Chinese
ones reach 9,999,999,999,999,999, which a JavaScript number cannot hold.

### Round 114

285. **A box with a ratio and a height was as wide as its container**, and
     one whose width was `min-content`, `max-content` or `fit-content` as
     wide as what was in it. Its width is its height's through the ratio
     (CSS Sizing 4, 5.1) — a height of its own, or, for an absolute box
     with a `top` and a `bottom`, the height they leave it — and a
     `min-content`, `max-content` or `fit-content` height is `auto`. A
     least or greatest height is a least or greatest width through the
     ratio wherever the box's width is its own to find: a block's, a
     shrink-to-fit one's, and an absolute box's that both its offsets
     stretch.
286. **A box with a ratio grew to hold its content whatever its
     `min-height` said.** Its content is only its automatic minimum
     (5.2), so `min-height: 0` lets the ratio hold what overflows it. And
     its two margins went on through it as an empty block's do, where the
     height its ratio gives it parts them.
287. **A flex item with a ratio was as wide across a column as its
     content**, whatever height it was flexed to; it is that height's width
     through the ratio (CSS Flexbox 9.4). Along a row, its automatic
     minimum is a definite height's width through the ratio — its own, or
     its line's where it is stretched across one of a definite height — or
     its content's at its narrowest, the wider, and no more than a width of
     its own (4.5); and a `min-height` holds it to a width through the
     ratio even where its content is no wider than its padding, which let
     it shrink to nothing. Down a column, its flex base size is its width's
     height through the ratio (9.2.3), and its automatic minimum is held
     within what its least and greatest widths make of heights. An image
     grown along a row is as tall as its ratio makes its new width.
288. **Yoga takes a `flex-basis` only in a flex box whose main size is
     definite**, and down a column of no height of its own it read
     `flex: 0 0 3rem` as the item's height, or as its content's. There the
     basis is handed to it as the item's height, which is what the height
     is to a basis anyway. A `content-box` basis down a column took the
     item's left and right padding for its top and bottom.
289. **A stretched flex item was never shorter than what it held.** It is
     its line's height (9.4, step 11), so an item with a ratio no longer
     grows past its line to the height of its width.
290. **`overflow: clip` was read as `hidden`**, and so made a formatting
     context of its own and a scroll container. It clips the same, and
     makes neither (CSS Overflow 3, 3.1): a margin in it collapses through
     its edge, the floats in it are not held in it, and a flex or grid item
     keeps its automatic minimum. The two axes compute together: beside a value that
     scrolls, `visible` is `auto` and `clip` is `hidden`.
291. **A written `<html>` had no body.** htmlparser2 puts content where it
     stands, and HTML's parser puts it in a body (13.2.6.4), so the root
     box stood in for a body around the `<html>`, and a first paragraph's
     margin stood below the body's rather than collapsing with it. The
     first thing in an `<html>` that is not head content opens a body now;
     content before a written `<body>`, or after it ends, goes in it; and a
     second `<body>`'s attributes go on the first. Thirteen tests across
     CSS 2.1, css-overflow, css-tables, css-text, css-values and css-align
     wrote their pages so.
292. **An SVG image's root background was not painted.** A browser paints
     it over the canvas, which for an image is the whole of it, wherever
     the `viewBox` puts the drawing.

css-sizing went from 258 to 336 of 562 on X11 and from 257 to 335 on
Cocoa, css-flexbox from 646 to 669 of 1,012 and from 644 to 665,
css-overflow from 265 to 268 and css-text from 656 to 662 on X11; the CSS
2.1 suite went from 5,651 to 5,652 on X11 and from 5,102 to 5,103 on
Cocoa. One test passed by an
accident this ends: `balance-percentage-size-002` lays out three squares
in two lines with the experimental `flex-wrap: balance`, which `<Html>`
does not do, and matched its reference only while each item's width was
not its height's through its ratio. `flex-aspect-ratio-038` fails because
Yoga shares out a column's free space from each item's size within its
limits rather than from its flex base size, as Chrome 101 and Firefox 99
did.

### Round 115

293. **A grid item with a ratio was sized as one without.** `normal`
     stretched an image across its column, and a box with an
     `aspect-ratio` and a height was as wide as its column. CSS Grid 1, 6.2
     sizes either as a block would be: an image at its own size, and a box
     with a ratio as wide as a height it has makes it — its own, a
     percentage of rows whose sizes are lengths, or those rows' where its
     own `align-self` stretches it — and else as wide as its column; and
     that width is what it gives its column. An item stretched down its
     area by its own `align-self` is as wide as its ratio makes that
     height, and one stretched across by its own `justify-self` as tall as
     it makes that width. `justify-items` and `justify-self` keep `normal`
     apart from `stretch`. A scroll container's sizes take nothing from its
     ratio.
294. **A grid item's percentage height was of the grid's height**, so
     `height: 100%` in one of two rows was as tall as both. It is of its
     area: of the rows it spans where their sizes are lengths, and once the
     rows are sized, of what they came to, the item laid out again; and
     what is in a stretched item takes its percentages of the item's
     height, as in a stretched flex item.
295. **`auto-fit` was `auto-fill`.** A repetition that no item is in
     collapses: out of the sizing and of the space `justify-content` and
     `align-content` share out, the gaps on either side of it one gap
     (7.2.3.2).
296. **A percentage gap was dropped.** `gap`, `row-gap` and `column-gap`
     are a percentage of the content box's size along them, in a grid and
     a flex box alike, and where that size is not known — a grid with no
     height of its own — of the size the tracks come to without them (CSS
     Box Alignment 3, 8.3); `normal` is nought.
297. **A grid was as wide as where its items ended**, so an item wider than
     its column made the grid wider than its tracks. It is as wide as its
     tracks. An item whose width is `min-content` or `max-content` gives
     its column that width at its narrowest and at its widest.

css-grid went from 473 to 550 of 1,651 on X11 and from 432 to 509 on
Cocoa, css-sizing from 336 to 352 of 562 and from 336 to 351, css-flexbox
from 669 to 671 and from 665 to 668; the CSS 2.1 suite is unchanged. Two `grid-lanes`
masonry tests, which `<Html>` does not do, passed by the accidents this
ends: `row-auto-repeat-024`'s reference is a grid of items `height: 100%`
tall, which matched the test's unstyled blocks only while the percentage
was of the whole grid, and `column-subgrid-grid-gap-008` matched its
reference only while a percentage gap was none.

### Round 116

298. **`stretch` was dropped**, and with it `-webkit-fill-available` and
     `-moz-available`, the names pages wrote it in first: a float, an
     inline-block or an absolute box with one was as wide as its content.
     It is what the box's margins leave of its containing block (CSS
     Sizing 3, 4.2), in `width`, `height`, and their least and greatest:
     an absolute box's what its offsets leave, from its static position
     where it has neither (CSS Position 3, 4.1); a block with a
     formatting context of its own, or an image, what the floats beside it
     leave; and an image one way, as tall or as wide as its ratio makes
     the other. Down a block, a margin that meets no border or padding of
     its parent, in a parent that is no formatting context of its own,
     counts for nothing, as it would collapse through the parent's edge.
     Where the containing block's height is not known, `stretch` is
     `auto`, and as a least height nothing; `max-height` keeps it, where
     it kept no keyword at all.
299. **An empty block with a `min-height` or a `height` of `stretch`** was
     taken by the margin walk for one its margins collapse through, and a
     parent was placed a margin lower than it is.
300. **A replaced flex item given a width down a column** answered the
     height its own style made at that width rather than the one its ratio
     makes of it, as along a row since round 114: one `width: 50%` wide
     took the percentage of its own width, and was half as tall as it
     is.

css-sizing went from 352 to 373 of 562 on X11 and from 351 to 373 on
Cocoa, one of the latter a fieldset whose radio buttons pass or fail with
the timing of their native drawing; the CSS 2.1 suite is unchanged.

### Round 117

301. **`contain` was not read.** Size containment lays a box out as though
     it held nothing (CSS Containment 2, 3.2): its content's widths and
     height are what `contain-intrinsic-size` gives, or none, and an image
     is as though it had no size or ratio of its own; `inline-size` does it
     across alone. Neither applies to a table or to a table's parts.
302. **Layout and paint containment** make the box a formatting context of
     its own, a stacking context — painted whole in its place, where a
     block of the flow is painted with its parent's — and the containing
     block of the absolute and fixed boxes in it (3.3, 3.5); layout
     containment keeps its baseline in, so an inline-block with it sits on
     its bottom; paint containment clips what it holds to its padding box.
303. **Style containment** keeps what its subtree does to counters and
     quotes in it (3.4): an increment or a set of a counter made outside it
     makes a new one instead, as though the element counting reset it for
     itself and its later siblings, and the quotes are as deep after it as
     they were before it. `display: contents` has none.
304. **Any containment on `<html>` or `<body>`** keeps the body's
     background and its `overflow` its own, rather than the canvas's and
     the viewport's.
305. **`content-visibility` was not read**: `auto` is layout, style and
     paint containment, and `hidden` all four, the box's content not
     painted (4). Whether an `auto` box is on screen, which would give it
     size containment off it, a document laid out whole does not ask.
306. **An image's `width` and `height` attributes** give it a ratio as well
     as a size (HTML 15.4.3): `aspect-ratio: auto w / h`, which an image
     with none of its own yet, or under size containment, is laid out by.

css-contain went from 110 to 243 of 431 on X11 and from 101 to 229 on
Cocoa, css-sizing from 373 to 397 of 562 on both; the CSS 2.1 suite is
unchanged.

## What `<Html>` supports

From the pass rates of the tests that use each feature, at the fixes above,
on X11. A rate is confounded — a test that uses a supported feature may fail
on another one beside it — so the column is a guide, and the verdict is
checked against the code.

| feature                                            | tests | pass    | verdict                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| block flow, margin collapsing                      | 694   | 83%     | **supported**, through empty blocks and into a parent's; a set of margins of both signs collapses two at a time                                                                                                                             |
| margins, padding, borders                          | 682   | 95%     | **supported**, inline boxes and collapsed table borders included; the `double`/`groove` families are approximations                                                                                                                         |
| floats and `clear`                                 | 311   | 46–67%  | **supported**, a float inside a paragraph at the top of the line it is met on; a word wider than its line is broken where CSS lets it overflow                                                                                              |
| relative and absolute positioning                  | 513   | 84%     | **supported**, against an inline box too; an absolute box inside a line is where the text before it left off                                                                                                                                |
| backgrounds: colour, image, repeat, position       | 336   | 85%     | **supported**, `background-attachment: fixed`, `background-size`, any number of layers and SVG images included                                                                                                                              |
| fonts: family, style, weight, size                 | 159   | 81%     | **supported**; `font-variant` is the font's own OpenType features, so small capitals are drawn where the font has them and not synthesized                                                                                                  |
| line height, `vertical-align`                      | 191   | 87%     | **supported**: every inline box's own line height, and `vertical-align` on text as well as on images and inline blocks; text in a font with taller natural lines than its paragraph's takes a bit more room than CSS gives it               |
| `white-space`                                      | 217   | 46%     | **supported**; collapsing is CSS 2.1's across elements                                                                                                                                                                                      |
| lists and markers                                  | 155   | 94%     | **supported**, `list-style-image` included                                                                                                                                                                                                  |
| CSS tables (`display: table-*`), `table-layout`    | 250   | 93%     | **supported**: HTML tables and anonymous ones, both border models, captions, `<col>` widths in both layouts, column backgrounds with their images, `visibility: collapse` and `empty-cells`; baseline alignment is not                      |
| `::before`, `::after`, `content`, counters, quotes | 332   | 86%     | **supported**, images in `content` included                                                                                                                                                                                                 |
| `::first-letter`, `::first-line`                   | 398   | 79–100% | `::first-letter` **supported**; `::first-line` **partial**: its colour and background, not its font, spacing or `vertical-align`                                                                                                            |
| `z-index` stacking                                 | 152   | 73%     | **supported**: Appendix E's order — block backgrounds, floats, lines, positioned boxes by `z-index` — with a table, a flex box or a box that clips painted whole among the lines, and the positioned boxes in one by their stacking context |
| SVG: inline, as an image, as a background          | 52    | 98%     | **supported**, as ntk's `SvgView` draws it: shapes, paths, `<use>`, gradients and text; no stylesheet rules, filters, masks or clip paths                                                                                                   |
| `clip`                                             | 44    | 100%    | **supported**                                                                                                                                                                                                                               |
| bidi: `direction`, `unicode-bidi`                  | 265   | 68%     | **partial**: shaping and the bidi algorithm are the engine's, `unicode-bidi` its controls, and a line's pieces are ordered by UAX #9's L2; an embedding does not reach across a padded element's edge                                       |
| selectors                                          | 468   | 94%     | **supported**                                                                                                                                                                                                                               |
| cascade, `@import`, `@media`                       | 134   | 66–75%  | **supported**                                                                                                                                                                                                                               |

The CSS3 subset documents actually use sits outside this suite and is listed
in [the plan](#a-static-html-widget-worth-having) below.

## Cocoa

After round 3, Cocoa passes 349 fewer tests than X11: 14 pass only on Cocoa
and 363 only on X11. After round 2 it was 111 and 376, and most of those 111
were X11's bug rather than Cocoa's merit — the block background painted
behind its own text (round 3, item 17), which Cocoa's runs had no spans to
show. What the tests that pass only on X11 come to, as counted after round
2:

- **85 are sub-pixel resampling.** At 2x every image is scaled, and
  CoreGraphics' interpolation at a tile's edge depends on where the tile
  lands, so a background drawn a tile at a time differs from the reference's
  `<img>` by at most 32 levels on a few hundred pixels. Nothing a reader
  sees, and a strict comparison counts it.
- **91 are line boxes**, and two things. CoreText put a line's leading
  under its glyphs, so the squares the tests build out of Ahem sat as much
  as half a glyph off; with the appkit fix above, 37 tests come out closer
  to their references and the median line-box difference falls from 1,682
  pixels to 122. What those still differ by is CoreText's font smoothing,
  which rims each glyph with a device pixel of grey that the references'
  boxes do not have: with smoothing off as well, Cocoa passes 104 of the 191
  line-box tests, X11 106. Smoothing is how macOS draws text, so it stays,
  and those tests fail there by design.
- **CoreText counts a line's trailing white space in its width**, and ntk
  does not: a line that ends in a space measures a space wider on macOS.
  Round 2 removes a collapsible space at the end of a block, as CSS does,
  so a shrink-to-fit box no longer grows by one; a space at the end of a
  wrapped line inside a paragraph is the engine's, and windowkit/appkit#81
  leaves it out of CoreText's widths. CoreText still keeps the space in the
  run that ends the line, so the inline painter clamps a run to its line.
  Both engines also hang a trailing no-break space, which CSS measures, so
  three float tests fail on both; that is the next fix, for both at once.
- **The rest** — positioning, floats, normal flow — are under investigation;
  the normal-flow tests that pass only on Cocoa point at a metric that
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

1. **Never hang, never throw.** Done for everything this suite reaches; for
   the 9,942 reftests of nineteen more of WPT's `css/` directories in round
   67 and the 5,002 of seventeen more in round 68; and for 9,000 pages the
   fuzzer made from this suite in round 68 and 6,000 it made from the
   other directories in round 69. Next: the rest of the `css/`
   tree, and its crash tests, which have no reference and so no place in
   this runner yet — a renderer that can freeze its host is worse than one
   that renders badly.
2. **Generated content**: `::before`, `::after`, `content` with strings,
   `attr()`, counters and quotes. About 330 tests, and used everywhere —
   clearfixes, icons, quotation marks, numbered headings. Done in round 2,
   and images in `content` in round 26.
3. **Tables as mail uses them**: anonymous table boxes, the collapsing
   border model, `table-layout: fixed`, row groups, captions. About 600
   tests, and the layout of most HTML mail. Anonymous tables were done in
   round 4, and collapsed borders, captions, footer groups and a table's
   height in round 5, and fixed layout with `<col>` widths in round 6.
4. **The inline formatting model**: a line height per inline box, the
   remaining `vertical-align` values, `text-align: justify`, and a float
   placed where its line has got to rather than before the line. White space
   and `font-size: 0` were done in round 2 and an inline box's padding,
   borders and margins in round 3, and the Cocoa line-box difference turned
   out to be CoreText's placement and its font smoothing. `vertical-align`
   on text was done in round 24 and a line height per inline box in round
   29, `justify` in round 48, and the float in round 66.
5. **The CSS3 that documents use**: `background-size`, `box-shadow`,
   gradients, `calc()`, custom properties (`var()`), CSS Color 4 —
   Tailwind's output is written in them — and `@font-face` through
   `onResource`. CSS Color 4's functions were done in round 19, read in
   this package rather than by ntk's colour parser, and `color-mix()` in
   round 22; relative colours remain. `calc()`, `min()`, `max()` and
   `clamp()` were done in round 20, custom properties in round 21, and the
   logical properties Tailwind 4 writes its spacing in, with `inset`, in
   round 33. Linear gradients were done in round 39, `box-shadow` in
   round 41 and `background-size` in round 56; the other gradients
   remain.
6. **Stacking and clipping**: stacking contexts across `z-index`, `clip`,
   the static position of an absolute box. Percentage heights were done in
   round 4; overflow clipping, `clip` and the static position in a block in
   round 5; the static position in a line in round 93, and stacking
   contexts in round 94.
7. **`::first-letter` and `::first-line`**: drop caps and small-cap lead-ins;
   about 400 tests, most of them Unicode punctuation classes.
   `::first-letter` was done in round 5, and `::first-line`'s colour and
   background in round 18.
8. **Bidi overrides**: `unicode-bidi: embed | bidi-override | isolate`, and
   an embedding resolved across a line rather than a piece at a time — which
   needs the text engine to take a line's pieces, an element's edges
   included, in one call.

## Lessons

1. **A conformance suite finds robustness bugs first.** The first full run
   hung on 91 documents and crashed on one — found in minutes, after the
   component had shipped with every one of them. Run a standard suite before
   believing a renderer is robust, and run it for hangs before pixels.
2. **Reftests pass by accident.** A feature neither the test nor its
   reference exercises passes on a renderer that lacks it; fixing one half
   turns such passes into failures. Diff every run against the last, test by
   test, and read the regressions before trusting a rate. Round 2's white
   space fix did it twice over: a space the renderer should never have
   drawn stood in for an inline box's missing padding in one test, and in
   another gave a word the break it needed to move below a float, which
   hid that a word with no room was being cut instead.
3. **Count the backend difference, not the backend.** A test passing on one
   backend and failing on the other is a backend bug with its reproduction
   attached; that list is worth more than either pass rate.
4. **A near miss can be the font's, not the layout's.** Ahem's box edges
   stand a fraction of a pixel off the grid at most sizes, and a browser
   hints them onto it; an engine that draws outlines where they fall
   antialiases every square's top and bottom rows. Sort failures by how
   much differs before reading them: the small ones are a different class.
5. **One difference can be two bugs, and a fix can show the second.**
   Moving macOS's baselines to where X11's are made two margin-collapse
   tests worse there: the test's paragraph kept a 20px line height it
   should have reset, which puts its baseline 0.8px from the reference's.
   X11 rounds both to the same pixel and passed; at 2x they are two device
   pixels apart. Rerun both backends after a fix to either, and read what
   got worse.
6. **Check a prediction against what it predicts.** Placing a block before
   its children are laid out means guessing whether an empty child is
   empty, and a wrong yes moves everything after it. A throw where layout
   disagrees with the guess, run over both suites before the throw was
   taken out, found the one case the guess got wrong: an empty `<span>`,
   which the guess called no line and layout's own check called content.
