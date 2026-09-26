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
| 4      | anonymous boxes and tables, CSS syntax, baselines  | 3,713 (63%) | 3,329 (56%) |
| 5      | first letters, tables, clipping, positioning       | 4,733 (80%) | 4,321 (73%) |

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

What is left falls in two kinds. **Features not built**: `::first-line`,
`table-layout: fixed` reading `<col>` widths, `background-attachment:
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

## What `<Html>` supports

From the pass rates of the tests that use each feature, at the fixes above,
on X11. A rate is confounded — a test that uses a supported feature may fail
on another one beside it — so the column is a guide, and the verdict is
checked against the code.

| feature                                            | tests | pass    | verdict                                                                                                                                                                            |
| -------------------------------------------------- | ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| block flow, margin collapsing                      | 694   | 83%     | **supported**, empty blocks collapsing through included; clearance remains                                                                                                         |
| margins, padding, borders                          | 682   | 95%     | **supported**, inline boxes and collapsed table borders included; the `double`/`groove` families are approximations                                                                |
| floats and `clear`                                 | 311   | 46–67%  | **supported**, with gaps: a float inside a paragraph is placed at the paragraph's top, not its line's                                                                              |
| relative and absolute positioning                  | 513   | 84%     | **supported**; an absolute box inside a line takes the line's start for its static position                                                                                        |
| backgrounds: colour, image, repeat, position       | 336   | 85%     | **supported**; `background-attachment: fixed` is not                                                                                                                               |
| fonts: family, style, weight, size                 | 159   | 81%     | **supported**; `font-variant: small-caps` is not                                                                                                                                   |
| line height, `vertical-align`                      | 191   | 72%     | **partial**: one line height per paragraph, where CSS gives each inline box its own                                                                                                |
| `white-space`                                      | 217   | 46%     | **supported**; collapsing is CSS 2.1's across elements                                                                                                                             |
| lists and markers                                  | 155   | 68%     | **supported**; `list-style-image` is not                                                                                                                                           |
| CSS tables (`display: table-*`), `table-layout`    | 250   | 37%     | **partial**: HTML tables lay out, borders collapse, captions go outside the table and anonymous tables are built; `table-layout: fixed` reads no `<col>` width                     |
| `::before`, `::after`, `content`, counters, quotes | 332   | 86%     | **supported**; an image in `content` is not                                                                                                                                        |
| `::first-letter`, `::first-line`                   | 395   | 19–100% | `::first-letter` **supported**; `::first-line` **missing**                                                                                                                         |
| `z-index` stacking                                 | 152   | 41%     | **partial**: z-order within one parent only                                                                                                                                        |
| `clip`                                             | 44    | 100%    | **supported**                                                                                                                                                                      |
| bidi: `direction`, `unicode-bidi`                  | 265   | 68%     | **partial**: shaping and the bidi algorithm are the engine's, a line's pieces are ordered by UAX #9's L2; an override that crosses a padded element is resolved on each side of it |
| selectors                                          | 468   | 94%     | **supported** except `::first-line`                                                                                                                                                |
| cascade, `@import`, `@media`                       | 134   | 66–75%  | **supported**                                                                                                                                                                      |

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
   tests, and the layout of most HTML mail. Anonymous tables were done in
   round 4, and collapsed borders, captions, footer groups and a table's
   height in round 5; `table-layout: fixed` reading `<col>` widths remains.
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
   round 4; overflow clipping, `clip` and the static position in a block in
   round 5. Stacking contexts remain.
7. **`::first-letter` and `::first-line`**: drop caps and small-cap lead-ins;
   about 400 tests, most of them Unicode punctuation classes.
   `::first-letter` was done in round 5.
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
