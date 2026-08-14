# TerminalOutput

```jsx
import { TerminalOutput } from '@react-x11/components/terminal-output';

<TerminalOutput data={await readFile('build.log')} lineNumbers />;
```

A captured terminal session, rendered. Bytes a program wrote to a pty go in —
escape sequences and all — and what the terminal would have drawn comes out.

It is to [`<Terminal>`](terminal.md) what [`<Code>`](code.md) is to
[`<CodeEditor>`](code-editor.md): the static, read-only sibling. There is no
pty, no process, no `write()` and no key handling, because there is nothing on
the other end to write to.

**It registers no host element.** The composition is one
[`<richtext>`](richtext.md) for the whole capture inside a `selectable` root,
plus an optional line-number gutter — the same shape `<Code>` has, and the
same selection, copy and PRIMARY behaviour, which are core's.

The parser is its own shared module, [`/ansi`](ansi.md), and is useful without
a terminal anywhere near it.

## A log is a document, not a grid

The design decision behind the whole component, and the one worth
understanding before reaching for it.

A build log — `npm test`, `git log --color`, a CI job — has **lines, not
rows**, and no column count of its own. It moves forward, colours things, and
rewinds inside a line for a progress bar. Rendering that on a fixed grid means
inventing a `cols` the capture never had and then wrapping or truncating at
it. So this renders it as a document of styled spans: it wraps if you ask, it
flows in a page, and text selects across it like any other block.

A capture from a full-screen program — vim, htop, an installer's TUI — is a
different thing. Those bytes address the cursor absolutely, scroll regions and
take the alternate screen, and they mean nothing except at the exact
`cols × rows` the program was told. **That case is not rendered faithfully
here yet**, and the component says so rather than guessing: `onDocument` hands
over a document whose `needsScreen` is true, with `dropped` naming every
sequence that went unhonoured and how often. A real cell-grid renderer for it
is phase 2 — see [the PRD](../prd-terminal-output.md).

```jsx
<TerminalOutput
  data={capture}
  onDocument={(doc) => setNeedsScreen(doc.needsScreen)}
/>
```

## Props

| Prop             | Type                          | What it does                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`           | `AnsiInput \| AnsiDocument`   | The capture: a string, a `Uint8Array`, an array of either, or an already-parsed document. **Bytes are preferred** — see below.                                                                                                                                                                                                      |
| `mode`           | `'auto' \| 'flow'`            | Which renderer. The two are the same today; `'screen'` joins the union in phase 2, at which point `'auto'` starts following the bytes. Pin `'flow'` if a log should stay a document whatever it contains. Default `'auto'`.                                                                                                         |
| `colors`         | `AnsiPaletteOptions`          | The palette — `<Terminal>`'s `colors` minus `cursor`, which a static render has no use for. By default the ink is the theme's text colour and the block wears the same faint tint a `<Code>` block does, so a log sits in a page rather than punching a dark rectangle into it. Pass `background`/`foreground` for a terminal pane. |
| `tabWidth`       | `number`                      | Default 8, the terminal's.                                                                                                                                                                                                                                                                                                          |
| `maxLines`       | `number`                      | Keep only the last N lines. Unbounded by default: the app read the file, so the app decided how big it is. `onDocument`'s `truncated` counts what went.                                                                                                                                                                             |
| `wrap`           | `boolean`                     | Wrap long lines instead of scrolling horizontally. Default false — a terminal's lines are the length they are.                                                                                                                                                                                                                      |
| `lineNumbers`    | `boolean`                     | A gutter. The numbers are `selectable={false}`, so a copied log carries none of them. Ignored when `wrap` is on, for the reason `<Code>` ignores it: a wrapped line puts the numbering out of register.                                                                                                                             |
| `selectable`     | `boolean`                     | Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true.                                                                                                                                                                                                                                                                            |
| `selectionColor` | `string`                      | Selection band fill. Default: the theme accent at 35% opacity.                                                                                                                                                                                                                                                                      |
| `fontSize`       | `number`                      | Default 0.9 × the theme `fontSize`, matching `<Code>` and `<Markdown>`'s fenced blocks.                                                                                                                                                                                                                                             |
| `monoFamily`     | `string`                      | Default `'monospace'`. A capture was made in a monospace font whatever the app is set in.                                                                                                                                                                                                                                           |
| `onLink`         | `(href, ev) => void`          | An OSC 8 hyperlink was clicked. Without a handler the link text is styled and inert — this component never opens anything by itself.                                                                                                                                                                                                |
| `onDocument`     | `(doc: AnsiDocument) => void` | The parse, whenever it changes: `title`, `needsScreen`, `dropped`, `truncated`.                                                                                                                                                                                                                                                     |
| `style`          | `Style \| Style[]`            | The root box.                                                                                                                                                                                                                                                                                                                       |

## Feeding it

**Bytes beat a string.** A `.toString()` on whatever boundary a reader chose
cuts a multi-byte character in half, and no care downstream repairs it — the
same rule [`PtyHost.onData`](terminal.md) carries for the live terminal. A
`Uint8Array` (a node `Buffer` is one) is decoded across chunk boundaries, so
an array of them is safe.

**An array is the incremental path.** When it grows and its existing elements
keep their identity, only the new ones are parsed, and an escape sequence or a
UTF-8 character split across the boundary is held rather than mangled. A
growing _string_ is handled too, by prefix, which is cheaper than re-parsing
but not free — push chunks into an array for a live tail.

```jsx
const [chunks, setChunks] = useState([]);
// child.stdout.on('data', (buf) => setChunks((prev) => [...prev, buf]));

<TerminalOutput data={chunks} />;
```

## What flow mode honours, and what it drops

Honoured exactly: **SGR in full** (the 16, the 256 cube, truecolor, and the
`:` sub-parameter forms, so `4:3` curly underlines and `58` underline colours
work); `\r`, `\n`, `\b` and `\t`; `\e[K` and its `1K`/`2K` variants;
`\e[nC`/`\e[nD`/`\e[nG` inside a line; `\e[nX`/`\e[nP`/`\e[n@`; **OSC 8
hyperlinks**; and OSC 0/2 titles.

**`\r` is most of the value.** Every progress bar, spinner and `npm install`
line is a carriage return plus an overwrite. A renderer that treats `\r` as a
newline turns a three-line install into nine hundred.

Dropped, and counted in `dropped`: cursor addressing (`CUP`, `CUU`, `CUD`,
`VPA`), `ED`, `IL`/`DL`, scroll regions, the alternate screen, DEC private
modes, device queries, OSC 52, and Sixel / Kitty / iTerm2 image envelopes.
Everything in that list is **recognised and consumed** even where it is
discarded — a parser that does not understand a sequence's structure prints
its payload as text, which is the classic garbage-on-screen bug.

Three things are parsed onto the span and not painted, so they are visible in
`onDocument` but not on screen: **blink** (a static render that repaints twice
a second is not static), **overline** (`<richtext>` draws no rule above), and
**East Asian wide characters take one column rather than two** in the line
model — which only matters if a capture rewinds past CJK text with `\r` or
`\e[nG`, and never affects the text itself.

## Decisions rather than gaps

- **Colour is kept as intent through the parse and resolved at paint.** A span
  says "ANSI 2", not `#00cd00`. That is what lets one parsed capture render
  correctly against a light theme and a dark one, and what makes `colors`
  mean something after the fact.
- **Text in the default background paints no rectangle.** It is what lets a
  log sit inside a page instead of becoming an opaque strip, and it is why
  `colors.background` is the prop that turns the block into a terminal pane.
- **This is not a player.** [`parseCast`](ansi.md) reads an asciinema
  recording and `castOutput(cast, { until })` gives the bytes up to a moment;
  scheduling the moments is the app's. A component with a timer inside it
  never settles in a screenshot test.
- **No input, ever.** No `write()`, no key encoding, no mouse reporting, no
  OSC 52 clipboard writes. A capture cannot answer a device query, so nothing
  here asks it one — and an OSC 52 in a capture is a _recording_ of a
  clipboard write, not a request to perform one.

## Example

```bash
npm run examples:terminal-output
```

A build log, an `npm install` driven by carriage returns, a `cargo`-style
capture with OSC 8 hyperlinks, and a `vim` session that reports it wanted a
screen.
