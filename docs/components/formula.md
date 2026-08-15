# Formula

```jsx
import { Formula } from '@react-x11/components/formula';

<Formula tex="x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}" display selectable />;
```

TeX mathematics, rendered natively. KaTeX (an optional dependency) parses
the source into its virtual DOM; this component's registered `formula`
element lays that tree out in pixels and draws it through the app's font
manager, using KaTeX's own faces — loaded from the `katex` package the
first time a formula mounts. Every glyph answers core's four text
accessors, so the mathematics is **selectable**: on its own surface with
the `selectable` prop, or as part of any `selectable` document that
contains it.

The name is `Formula` rather than `Math` or `Tex` on purpose: `Math` is a
JavaScript global that an import would shadow, and `Tex` names the input
syntax — which is a prop (`tex`), so a future MathML or AsciiMath source is
a sibling prop, not a second component.

## Props

| Prop             | Type                     | What it does                                                                                                                                                                                                        |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tex`            | `string`                 | The TeX source. Append to it as chunks stream in.                                                                                                                                                                   |
| `display`        | `boolean`                | KaTeX's display mode: centered on its own line, large operators, limits above and below. Default false — inline style, left-aligned.                                                                                |
| `partial`        | `boolean`                | More source may still arrive. While true, an unparseable source renders the last tree that parsed — or, before anything has, the raw source as muted code. Default false: a parse error renders KaTeX's error text. |
| `size`           | `number`                 | Pixels per em. Default: theme `fontSize` × 1.21 — the ratio katex.css uses, so mathematics holds its own beside body text.                                                                                          |
| `color`          | `string`                 | Ink color. Default: theme `text`. `\color` inside the expression wins locally.                                                                                                                                      |
| `errorColor`     | `string`                 | The color of KaTeX's error rendering once the stream is final. Default `#cc0000`.                                                                                                                                   |
| `macros`         | `Record<string, string>` | KaTeX macros, e.g. `{ '\\RR': '\\mathbb{R}' }`.                                                                                                                                                                     |
| `selectable`     | `boolean`                | Make the formula its own selection surface — mouse, Ctrl+A / Ctrl+C, PRIMARY. Default false; see below.                                                                                                             |
| `selectionColor` | `string`                 | Selection band fill, when `selectable`.                                                                                                                                                                             |
| `style`          | `Style \| Style[]`       | The root `<box>`'s style — margins, padding, `overflow`.                                                                                                                                                            |

## Selection, and when not to ask for it

The element implements the four text accessors from react-x11's
docs/extending.md, which is the whole of joining a `selectable` document:
core walks the tree, asks each node for its text and its rectangles, and
the formula answers glyph by glyph. So inside a `<Markdown>` document (or
any other `selectable` surface) leave `selectable` off — the document's
surface already reads the mathematics, and a second surface underneath it
would capture the drag instead of joining it. Set `selectable` for a
formula standing alone.

What a copy contains is the glyphs in **reading order**: numerator before
denominator, superscript before subscript, matrix cells top-down. That
order is derived from the laid-out geometry (topmost row of each stack
first), not from the DOM order KaTeX emits, which interleaves both
directions. The drawn-not-written marks — fraction bars, surds — are
geometry, not text, and are not copied.

## Missing katex is an ordinary state

`katex` is an `optionalDependency`. Without it the component renders the
source as muted monospace text — which still reads, still selects (core's
`<text>` answers for itself), and never throws. The same posture as a
`<MediaPlayer>` with no player installed. The KaTeX font files ride along
with the package and are registered into the app's font manager on first
use; on a machine where they cannot be read, shaping falls back to system
fonts and the mathematics is merely less beautiful.

## Streaming

A formula in a streaming document arrives a few characters at a time, and
half a formula does not parse. While `partial`, the component re-parses on
every append and keeps showing the last tree that parsed, so the
mathematics upgrades in place and never flashes an error; before anything
has parsed, the raw source shows as muted code — a fence _is_ a code block
until its content can be read. Flip `partial` off when the stream ends.

## In a markdown document

`<Markdown>`'s `fences` seam is how a ```math fence becomes a formula —
the map keeps `<Markdown>` from importing `<Formula>`, per the no-lateral-
imports rule:

```jsx
const FENCES = {
  math: ({ text, partial }) => <Formula tex={text} display partial={partial} />,
};

<Markdown source={doc} partial={streaming} fences={FENCES} />;
```

See [Markdown](markdown.md) for the seam's contract.

## What the layout is

KaTeX's HTML output is a tree browsers lay out with a small, deliberate
subset of CSS. `src/formula/layout.ts` implements that subset directly —
inline flow with em margins, the vlist's absolutely-positioned rows,
border-bottom rules, the font classes, `text-align` on fraction stacks,
svg surds — with vertical geometry taken from the tree (KaTeX computes
every node's height and depth) and horizontal geometry measured through
ntk against the same faces that will draw. It is pure and exported
(`layoutFormula`), so tests assert baselines without a display.

Known limits, all of the degrade-gracefully kind: `\overbrace`'s
three-piece stretchy braces and `\cancel` overlays render approximately,
and a formula does not wrap — an over-wide one overflows its box, so give
a long formula `overflow: 'scroll'` the way a code block gets it.

```bash
npm run examples:formula
```
