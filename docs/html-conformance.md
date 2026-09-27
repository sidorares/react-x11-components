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
- **Pages are decoded, and stylesheets handed over as bytes**, as WPT's
  server and a browser do it. The runner finds a page's encoding from a
  byte order mark, the charset its `.headers` file serves it with, or its
  XML declaration or `<meta>`, and passes it on as the `charset` prop. It
  hands each stylesheet over as bytes, with the charset from its own
  `.headers`, and `<Html>` decodes it as CSS says.

A test passes when the two pictures match. A renderer that draws neither the
test nor the reference passes too; the runner records both-blank passes
separately, and there are six.

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

## What `<Html>` supports

From the pass rates of the tests that use each feature, at the fixes above,
on X11. A rate is confounded — a test that uses a supported feature may fail
on another one beside it — so the column is a guide, and the verdict is
checked against the code.

| feature                                            | tests | pass    | verdict                                                                                                                                                                                                                       |
| -------------------------------------------------- | ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| block flow, margin collapsing                      | 694   | 83%     | **supported**, through empty blocks and into a parent's; a set of margins of both signs collapses two at a time                                                                                                               |
| margins, padding, borders                          | 682   | 95%     | **supported**, inline boxes and collapsed table borders included; the `double`/`groove` families are approximations                                                                                                           |
| floats and `clear`                                 | 311   | 46–67%  | **supported**, with gaps: a float inside a paragraph is placed at the paragraph's top, not its line's                                                                                                                         |
| relative and absolute positioning                  | 513   | 84%     | **supported**; an absolute box inside a line takes the line's start for its static position                                                                                                                                   |
| backgrounds: colour, image, repeat, position       | 336   | 85%     | **supported**, `background-attachment: fixed`, `background-size`, any number of layers and SVG images included                                                                                                                |
| fonts: family, style, weight, size                 | 159   | 81%     | **supported**; `font-variant` is the font's own OpenType features, so small capitals are drawn where the font has them and not synthesized                                                                                    |
| line height, `vertical-align`                      | 191   | 87%     | **supported**: every inline box's own line height, and `vertical-align` on text as well as on images and inline blocks; text in a font with taller natural lines than its paragraph's takes a bit more room than CSS gives it |
| `white-space`                                      | 217   | 46%     | **supported**; collapsing is CSS 2.1's across elements                                                                                                                                                                        |
| lists and markers                                  | 155   | 94%     | **supported**; `list-style-image` is not                                                                                                                                                                                      |
| CSS tables (`display: table-*`), `table-layout`    | 250   | 81%     | **supported**: HTML tables and anonymous ones, both border models, captions, `<col>` widths in both layouts, and column backgrounds with their images; `visibility: collapse` and baseline alignment are not                  |
| `::before`, `::after`, `content`, counters, quotes | 332   | 86%     | **supported**, images in `content` included                                                                                                                                                                                   |
| `::first-letter`, `::first-line`                   | 398   | 79–100% | `::first-letter` **supported**; `::first-line` **partial**: its colour and background, not its font, spacing or `vertical-align`                                                                                              |
| `z-index` stacking                                 | 152   | 73%     | **supported**: Appendix E's order — block backgrounds, floats, lines, positioned boxes by `z-index` — with a table, a flex box or a box that clips painted whole among the lines                                              |
| SVG: inline, as an image, as a background          | 52    | 98%     | **supported**, as ntk's `SvgView` draws it: shapes, paths, `<use>`, gradients and text; no stylesheet rules, filters, masks or clip paths                                                                                     |
| `clip`                                             | 44    | 100%    | **supported**                                                                                                                                                                                                                 |
| bidi: `direction`, `unicode-bidi`                  | 265   | 68%     | **partial**: shaping and the bidi algorithm are the engine's, `unicode-bidi` its controls, and a line's pieces are ordered by UAX #9's L2; an embedding does not reach across a padded element's edge                         |
| selectors                                          | 468   | 94%     | **supported**                                                                                                                                                                                                                 |
| cascade, `@import`, `@media`                       | 134   | 66–75%  | **supported**                                                                                                                                                                                                                 |

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

1. **Never hang, never throw.** Done for everything this suite reaches. Next:
   run all of WPT's `css/` tree for crashes alone, reftest or not, and a
   fuzzer over the CSS parser — a renderer that can freeze its host is worse
   than one that renders badly.
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
   29, and `justify` in round 48; the float remains.
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
   round 5. Stacking contexts remain.
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
