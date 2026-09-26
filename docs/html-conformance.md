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

| round  | what it was                                        | X11         | Cocoa       |
| ------ | -------------------------------------------------- | ----------- | ----------- |
| before | `<Html>` as it shipped                             | 1,831 (31%) |             |
| 1      | the first nine fixes below                         | 2,417 (41%) | 2,212 (38%) |
| 2      | generated content, and what it brought to light    | 2,822 (48%) | 2,557 (43%) |
| 3      | the inline box model, and what it brought to light | 3,180 (54%) | 2,831 (48%) |
| 4      | anonymous boxes, table columns, percentage heights | 3,323 (56%) | 2,959 (50%) |

Of 5,895 reftests run through round 2 and 5,894 since, where a test that
depends on an `onload` handler is counted a script. As it shipped, `<Html>`
hung on 91 of them and threw from paint on one; no round since has done
either. The hangs were the renderer looping for ever inside a render, which
freezes an application whole; they are the first finding, and the most
important one. Round 3's Cocoa number and round 4's are on react-x11 2.22.8
and @windowkit/appkit 0.15.0, where master itself passed 2,454, not round
2's 2,557 — see round 3's third item for the hundred tests between them.

By area, sorted by the number of tests:

| area                 | before, X11   | round 3, X11  | round 3, Cocoa | round 4, X11  | round 4, Cocoa |
| -------------------- | ------------- | ------------- | -------------- | ------------- | -------------- |
| normal-flow          | 217/694 (31%) | 483/694 (70%) | 461/694 (66%)  | 515/694 (74%) | 489/694 (70%)  |
| margin-padding-clear | 369/682 (54%) | 459/682 (67%) | 436/682 (64%)  | 470/682 (69%) | 444/682 (65%)  |
| positioning          | 129/513 (25%) | 293/513 (57%) | 282/513 (55%)  | 297/513 (58%) | 286/513 (56%)  |
| borders              | 255/504 (51%) | 324/504 (64%) | 322/504 (64%)  | 344/504 (68%) | 342/504 (68%)  |
| selectors            | 62/468 (13%)  | 73/468 (16%)  | 73/468 (16%)   | 74/468 (16%)  | 74/468 (16%)   |
| text                 | 186/381 (49%) | 251/380 (66%) | 224/380 (59%)  | 253/380 (67%) | 225/380 (59%)  |
| backgrounds          | 114/336 (34%) | 194/336 (58%) | 128/336 (38%)  | 198/336 (59%) | 132/336 (39%)  |
| syntax               | 147/275 (53%) | 170/275 (62%) | 170/275 (62%)  | 170/275 (62%) | 170/275 (62%)  |
| tables               | 12/250 (5%)   | 18/250 (7%)   | 18/250 (7%)    | 22/250 (9%)   | 22/250 (9%)    |
| floats-clear         | 13/211 (6%)   | 109/211 (52%) | 87/211 (41%)   | 120/211 (57%) | 98/211 (46%)   |
| generated-content    | 17/205 (8%)   | 130/205 (63%) | 133/205 (65%)  | 155/205 (76%) | 156/205 (76%)  |
| linebox              | 41/191 (21%)  | 112/191 (59%) | 22/191 (12%)   | 113/191 (59%) | 22/191 (12%)   |
| css1                 | 18/164 (11%)  | 91/164 (55%)  | 50/164 (30%)   | 95/164 (58%)  | 51/164 (31%)   |
| fonts                | 45/159 (28%)  | 88/159 (55%)  | 84/159 (53%)   | 96/159 (60%)  | 92/159 (58%)   |
| lists                | 12/155 (8%)   | 75/155 (48%)  | 75/155 (48%)   | 77/155 (50%)  | 77/155 (50%)   |
| bidi-text            | 4/105 (4%)    | 43/105 (41%)  | 14/105 (13%)   | 44/105 (42%)  | 14/105 (13%)   |
| floats               | 17/100 (17%)  | 28/100 (28%)  | 28/100 (28%)   | 30/100 (30%)  | 30/100 (30%)   |
| box-display          | 17/86 (20%)   | 35/86 (41%)   | 27/86 (31%)    | 41/86 (48%)   | 33/86 (38%)    |
| ui                   | 39/52 (75%)   | 39/52 (75%)   | 39/52 (75%)    | 37/52 (71%)   | 37/52 (71%)    |
| visufx               | 3/49 (6%)     | 3/49 (6%)     | 3/49 (6%)      | 3/49 (6%)     | 3/49 (6%)      |
| pagination           | 38/43 (88%)   | 41/43 (95%)   | 41/43 (95%)    | 41/43 (95%)   | 41/43 (95%)    |
| visudet              | 6/37 (16%)    | 13/37 (35%)   | 14/37 (38%)    | 13/37 (35%)   | 14/37 (38%)    |
| cascade              | 12/32 (38%)   | 21/32 (66%)   | 21/32 (66%)    | 22/32 (69%)   | 22/32 (69%)    |
| zindex               | 13/29 (45%)   | 14/29 (48%)   | 14/29 (48%)    | 14/29 (48%)   | 14/29 (48%)    |
| visuren              | 4/26 (15%)    | 9/26 (35%)    | 6/26 (23%)     | 9/26 (35%)    | 6/26 (23%)     |
| abspos               | 3/25 (12%)    | 8/25 (32%)    | 8/25 (32%)     | 12/25 (48%)   | 12/25 (48%)    |
| values               | 8/25 (32%)    | 11/25 (44%)   | 7/25 (28%)     | 11/25 (44%)   | 7/25 (28%)     |
| sec5                 | 11/23 (48%)   | 21/23 (91%)   | 21/23 (91%)    | 21/23 (91%)   | 21/23 (91%)    |
| colors               | 2/19 (11%)    | 5/19 (26%)    | 4/19 (21%)     | 6/19 (32%)    | 5/19 (26%)     |
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

Three things the fix-up and the height rules got wrong, found reading round
3's losses:

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

Sixteen tests that passed in round 3 fail now, the same on both backends:
twelve give a column or a column group a border, and two an outline, in a
table, and passed because the invented row drew the column's style as a
cell's. A column's borders count only where borders collapse (17.6.2),
which `<Html>` draws as separate borders with no spacing. The other two
cover an inline `<svg>` it does not draw with a box moved up over it, and
passed because the anonymous block around the `<svg>` took its parent's
300px height.

## What `<Html>` supports

From the pass rates of the tests that use each feature, at the fixes above,
on X11. A rate is confounded — a test that uses a supported feature may fail
on another one beside it — so the column is a guide, and the verdict is
checked against the code.

| feature                                            | tests | pass   | verdict                                                                                                                                                                                                                |
| -------------------------------------------------- | ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| block flow, margin collapsing                      | 694   | 51%    | **supported**; empty blocks collapsing through, and clearance, remain                                                                                                                                                  |
| margins, padding, borders                          | 682   | 67%    | **supported**, inline boxes included; border-collapse and the `double`/`groove` families are approximations                                                                                                            |
| floats and `clear`                                 | 311   | 27–41% | **supported**, with gaps: a float inside a paragraph is placed at the paragraph's top, not its line's                                                                                                                  |
| relative and absolute positioning                  | 513   | 42%    | **partial**: no static position for an absolute box with neither `top` nor `bottom`                                                                                                                                    |
| backgrounds: colour, image, repeat, position       | 336   | 53%    | **supported**; `background-attachment: fixed` is not                                                                                                                                                                   |
| fonts: family, style, weight, size                 | 159   | 54%    | **supported**; `font-variant: small-caps` is not                                                                                                                                                                       |
| line height, `vertical-align`                      | 191   | 55%    | **partial**: one line height per paragraph, where CSS gives each inline box its own                                                                                                                                    |
| `white-space`                                      | 217   | 39%    | **supported**; collapsing is CSS 2.1's across elements                                                                                                                                                                 |
| lists and markers                                  | 155   | 48%    | **supported**; `list-style-image` is not                                                                                                                                                                               |
| CSS tables (`display: table-*`), `table-layout`    | 250   | 6%     | **partial**: HTML tables lay out, and a table's missing row groups, rows and cells are generated; a table part outside a table gets no table around it, and `border-collapse: collapse` is drawn as the separate model |
| `::before`, `::after`, `content`, counters, quotes | 332   | 64%    | **supported**; an image in `content` is not                                                                                                                                                                            |
| `::first-letter`, `::first-line`                   | 395   | 1–16%  | **missing**                                                                                                                                                                                                            |
| `z-index` stacking                                 | 152   | 10%    | **partial**: z-order within one parent only                                                                                                                                                                            |
| `clip`                                             | 44    | 0%     | **missing**                                                                                                                                                                                                            |
| bidi: `direction`, `unicode-bidi`                  | 265   | 52%    | **partial**: shaping and the bidi algorithm are the engine's, a line's pieces are ordered by UAX #9's L2; an override that crosses a padded element is resolved on each side of it                                     |
| selectors                                          | 468   | 16%    | **supported** except `::first-letter` and `::first-line`, which are most of this area                                                                                                                                  |
| cascade, `@import`, `@media`                       | 134   | 57–62% | **supported**                                                                                                                                                                                                          |

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
   clearfixes, icons, quotation marks, numbered headings. Done in round 2;
   an image in `content` remains.
3. **Tables as mail uses them**: anonymous table boxes, the collapsing
   border model, `table-layout: fixed`, row groups, captions. About 600
   tests, and the layout of most HTML mail.
4. **The inline formatting model**: a line height per inline box, the
   remaining `vertical-align` values, `text-align: justify`, and a float
   placed where its line has got to rather than before the line. White space
   and `font-size: 0` were done in round 2 and an inline box's padding,
   borders and margins in round 3, and the Cocoa line-box difference turned
   out to be CoreText's placement and its font smoothing.
5. **The CSS3 that documents use**: `background-size`, `box-shadow`,
   gradients, `calc()`, custom properties (`var()`), CSS Color 4 — which
   needs ntk's colour parser to read `oklch()` and the space-separated
   `rgb()`; Tailwind's output is written in them — and `@font-face` through
   `onResource`.
6. **Stacking and clipping**: stacking contexts across `z-index`, `clip`,
   the static position of an absolute box. Percentage heights were done in
   round 4.
7. **`::first-letter` and `::first-line`**: drop caps and small-cap lead-ins;
   about 400 tests, most of them Unicode punctuation classes.
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
4. **One difference can be two bugs, and a fix can show the second.**
   Moving macOS's baselines to where X11's are made two margin-collapse
   tests worse there: the test's paragraph kept a 20px line height it
   should have reset, which puts its baseline 0.8px from the reference's.
   X11 rounds both to the same pixel and passed; at 2x they are two device
   pixels apart. Rerun both backends after a fix to either, and read what
   got worse.
