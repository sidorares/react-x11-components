# Mermaid

```jsx
import { Mermaid } from '@react-x11/components/mermaid';

<Mermaid
  source={'flowchart LR\n  A[Start] --> B{Is it?}\n  B -->|Yes| C[OK]'}
/>;
```

Mermaid diagrams, drawn natively. [ondine](https://ondine.sh), an
optional peer, compiles the source to SVG; this component reads that SVG
into outlines and text runs, themed from the palette, and its registered
`mermaid` element draws them and answers core's four text accessors. So
the labels are **selectable**: on their own surface with the `selectable`
prop, or as part of any `selectable` document that contains the diagram.
It runs on every backend; nothing in it is X11's or macOS's alone.

ondine is not Mermaid. It is a separate compiler, written in Rust and
shipped as WebAssembly, that follows Mermaid 12's syntax and does its own
layout: 33 diagram types (flowchart, sequence, class, state, ER, Gantt,
pie, git graph, mindmap, timeline, XY and quadrant charts, sankey,
architecture, C4 and more — [its list](https://ondine.sh)), drawn in its
own monochrome look of square outlines and rounded orthogonal edges.
Mermaid's themes and `%%{init}%%` theme variables do not apply; ondine's
`--ondine-*` properties do, through `vars`.

## Props

| Prop             | Type                           | What it does                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`         | `string`                       | The diagram, in Mermaid's syntax. Append to it as chunks stream in.                                                                                                                                                                                                                               |
| `partial`        | `boolean`                      | More source may still arrive. While true, a source that does not compile shows the last diagram that did — or, before anything has, the source as muted code. Default false: an error is shown, with the source under it.                                                                         |
| `fontSize`       | `number`                       | Logical pixels per em that labels are laid out and drawn at. Default: theme `fontSize`.                                                                                                                                                                                                           |
| `vars`           | `Record<string, string>`       | ondine's theme: `--ondine-fg`, `--ondine-bg`, `--ondine-muted`, `--ondine-line`, `--ondine-surface`, `--ondine-surface-alt`, `--ondine-border`, `--ondine-accent`, `--ondine-stroke`, `--ondine-radius`, `--ondine-font`, `--ondine-series-1`… Laid over the palette's. Keep its identity stable. |
| `options`        | `OndineRenderOptions`          | Passed to ondine's `render` — `maxWidth`, `autoDirection`, `padding`, `now` (the clock a Gantt chart's "today" reads)… Everything but `fontSize`, which is a prop of its own. Keep its identity stable.                                                                                           |
| `onLink`         | `(href, ev) => void`           | Follow a `click A "https://…"` link. The pointer is a hand over one. Without it, links are inert.                                                                                                                                                                                                 |
| `onError`        | `(error: OndineError) => void` | Told of a source that fails to compile once `partial` is false: `{ message, code, line, column }`, where `code` is `'syntax'`, `'semantic'`, `'limit'` or `'unsupported-diagram'`.                                                                                                                |
| `errorColor`     | `string`                       | The error message's colour. Default `#cc0000`.                                                                                                                                                                                                                                                    |
| `selectable`     | `boolean`                      | Make the diagram its own selection surface — mouse, Ctrl+A / Ctrl+C, PRIMARY. Default false; see below.                                                                                                                                                                                           |
| `selectionColor` | `string`                       | Selection band fill, when `selectable`.                                                                                                                                                                                                                                                           |
| `style`          | `Style \| Style[]`             | The root `<box>`'s style — margins, padding.                                                                                                                                                                                                                                                      |

`useOndine()` answers the compiler, `'unavailable'`, or `null` while it
loads, for an app that wants to gate its own UI on it.

## Theme

The palette sets four of ondine's properties — `--ondine-fg` from `text`,
`--ondine-bg` from `background`, `--ondine-muted` from `textMuted` and
`--ondine-font` from `monoFamily` — so a diagram is drawn in the window's
ink on a dark palette as on a light one. Everything else is ondine's
default, which is the foreground again: lines, borders and the series
colours are mixes of the ink into the ground. `vars` overrides any of
them, by the names ondine documents.

ondine lays a label out at 0.6 em a character, which is a monospace face's
advance, and the boxes it draws are sized from that. The default font is
the palette's `monoFamily` for that reason; a proportional `--ondine-font`
draws, but its labels will not sit in their boxes as well.

## Size

A diagram is drawn at its own size — `fontSize` sets it — and one wider
than the column it is in **shrinks to fit**, labels and all, the way an
image under `max-width: 100%` does. It does not grow. A left-to-right
flowchart that should turn top-to-bottom when narrow is ondine's to lay
out: pass `options={{ maxWidth }}`.

## Selection, and when not to ask for it

The element answers the four text accessors from react-x11's
docs/extending.md over the labels, so inside a `<Markdown>` document (or
any other `selectable` surface) leave `selectable` off — the document's
surface already reads the labels, and a second surface underneath would
capture the drag instead of joining it. Set `selectable` for a diagram
standing alone.

What a copy contains is the labels in **reading order**, one to a line: top
to bottom, and left to right along a row. ondine writes edges before nodes
and each label wherever its group is, so the document's own order would
read as noise; the order is derived from where each label is drawn.

## Missing ondine is an ordinary state

`ondine` is an optional **peer**, not an optional dependency, and that is a
judgement about weight. Compiling is cheap — the WebAssembly module
compiles once, in some 13 ms, and a diagram takes tens of microseconds
after that — but the install is not: the package carries every per-type
module twice over, and its CLI brings its own dependencies, some 46 MB in
all. That is node-pty's weight rather than KaTeX's, so it gets node-pty's
posture: an app that wants diagrams installs it.

```bash
npm install ondine
```

Without it the component renders the source as muted code — which still
reads, still selects, and never throws. ondine is at 0.0.x, so its API is
read structurally and defensively: the loader checks that `render` exists
and that a trivial diagram renders, and nothing past the SVG string is
relied on. Under Node and Bun it loads `ondine/compiler`, which reads its
module from the package; where that cannot run it falls back to the
WebAssembly entry with the module inlined.

## Streaming

A diagram in a streaming document arrives a line at a time, and half a
diagram does not compile. While `partial`, the component compiles on every
append and keeps showing the last diagram that compiled, so it grows in
place and never flashes an error; before anything has compiled, the source
shows as muted code — a fence _is_ a code block until it can be read. Flip
`partial` off when the stream ends, and an error is reported once.

## In a markdown document

`<Markdown>`'s `fences` seam is how a ```mermaid fence becomes a diagram —
the map keeps `<Markdown>` from importing `<Mermaid>`, per the
no-lateral-imports rule:

```jsx
const FENCES = {
  mermaid: ({ text, partial }) => <Mermaid source={text} partial={partial} />,
};

<Markdown source={doc} partial={streaming} fences={FENCES} />;
```

See [Markdown](markdown.md) for the seam's contract.

## Why it draws the SVG itself

ondine answers with an SVG document, and core has an `<svg>` element, so
the obvious build hands one to the other. It does not work, and would not
be enough if it did. Every colour ondine writes is a CSS custom property —
`fill="var(--_s)"`, defined on the root from `--ondine-*`, mixed with
`color-mix()` — and ntk's `SvgView` reads no custom properties, so the
diagram would come out black or not at all. And one opaque drawing is what
retired ntk's `<tex>` for `<Formula>`: nothing in it selects.

So `src/mermaid/scene.ts` reads the document into a scene — outlines with
every transform applied and their paint resolved, text runs with an anchor
and a face — and the element draws that. The SVG ondine writes is small
and regular (`g`, `path`, `rect`, `circle`, `polygon`, `text`/`tspan`,
`a`, a nested `svg` for an architecture icon), and an element outside it
is passed over rather than drawn wrongly. A label turned out of the
horizontal — an axis title, a git commit id at 45° — is drawn through its
turn: on macOS and Windows, whose contexts turn glyphs, directly; on X11
and Wayland, where ntk sets a glyph upright wherever a matrix puts it, set
level on a surface and the surface drawn through the turn.

```bash
npm run examples:mermaid
```
