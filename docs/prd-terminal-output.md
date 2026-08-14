# PRD: `src/ansi/` and `<TerminalOutput>` — rendering a captured session

Status: **phase 1 implemented**, phase 2 proposed. This document records the
design and the reasons, the way `prd-vt-terminal.md` does for the live
terminal and `prd-charts.md` does for the charts.

## What it is

`<TerminalOutput>` is to `<Terminal>` what `<Code>` is to `<CodeEditor>`: the
static, read-only sibling. It takes the bytes a program wrote to a pty —
escape sequences and all — and draws what a terminal would have drawn. No
pty, no process, no input, no `write()`.

```tsx
import { TerminalOutput } from '@react-x11/components/terminal-output';

<TerminalOutput data={await readFile('build.log')} style={{ flexGrow: 1 }} />;
```

The parser underneath is its own shared module and useful on its own:

```ts
import { parseAnsi } from '@react-x11/components/ansi';

const doc = parseAnsi(bytes);
doc.lines.map((l) => l.text); // the text, escapes gone
doc.needsScreen; // did this want a grid?
doc.dropped; // what could not be honoured, and how often
```

## The one design decision: two renderers, chosen by the bytes

A capture is one of two things, and the bytes say which.

**A log** — `npm test`, a build, `git log --color`, a CI job. SGR colours,
`\n`, `\r` for progress bars, the odd `\e[K`. Never addresses the cursor
absolutely. This is a **document**: it has lines, not rows, and no column
count of its own. Rendering it on a grid is a _downgrade_ — the grid invents
a `cols` the capture never had, then truncates or hard-wraps at it.

**A screen** — vim, htop, fzf, an installer's TUI. `CUP`/`CHA`/`VPA`, scroll
regions, the alternate screen. These bytes are meaningless except at the
exact `cols × rows` the program was told, and the only faithful rendering is
a grid replay.

So the component has two modes and picks by whether the parser ever saw an
absolute-addressing sequence:

- **`mode="flow"`** — the reducer produces spans; the component renders one
  `<richtext>`. Wraps, flows in a document, selects as part of the page,
  **zero optional dependencies**. This is the "array of coloured spans"
  instinct a web renderer has, and for a log it is not an approximation of
  the grid: it is the more correct model.
- **`mode="screen"`** — the bytes are replayed through `@xterm/headless` into
  a frozen buffer and drawn by `<vtterm>`, the element `<Terminal
backend="vt">` already uses. Exact cell fidelity, at the cost of a 2 MB
  optional dependency and a lazy chunk. **Phase 2.**
- **`mode="auto"`** (the default) — flow unless the parser saw addressing.

Detection is one boolean the parser already knows, and it is the only mode
decision that cannot be made from outside the data. Until phase 2 lands,
`auto` resolves to flow and reports the shortfall through `onMode`, so an app
can say "this recording needs a real screen" rather than quietly showing a
mangled one.

## The layering

Three pieces, in shapes this repo already has:

1. **`src/ansi/` — a shared module.** Side-effect free, no element, no React,
   no optional dependency: the parser and the flow reducer, pure. Asserted
   with no display, the posture `vt/colors.ts` and `vt/diff.ts` already take.
2. **`src/terminal-output/index.ts` — the component.** Flow mode is
   composition over `<richtext>`, calling `registerRichText()` at its own
   module scope. It registers no element of its own — the `<Calendar>` shape,
   not the `<CodeEditor>` one.
3. **`src/terminal-output/screen.ts`** — screen mode, behind a dynamic
   `import()` taken only when the mode resolves to `screen`. Phase 2.

## The data model

```ts
export type AnsiColor =
  | { kind: 'ansi'; index: number } // 0..255
  | { kind: 'rgb'; value: number }; // 0xRRGGBB
// "default" is the field being absent

export interface AnsiSpan {
  text: string;
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: AnsiUnderline; // 'single' | 'double' | 'curly' | …
  underlineColor?: AnsiColor;
  strike?: boolean;
  overline?: boolean;
  inverse?: boolean;
  conceal?: boolean;
  href?: string; // OSC 8
}

export interface AnsiDocument {
  lines: AnsiLine[]; // { spans, text }
  title?: string; // OSC 0/2
  needsScreen: boolean;
  dropped: Record<string, number>;
  state: AnsiState; // opaque; the resume point
}
```

**Colour is kept as intent through the parse and resolved at paint.** That is
what lets one parsed document render correctly against a light theme and a
dark one, makes a `colors.palette` prop mean something, and lets a test
assert "ANSI 2" rather than `#00cd00`. It is the split `codeblock` already
makes between `codeRuns` (tokens) and `codeBlockLook` (the palette), and it
reuses `buildPalette` and `resolveCell`'s transform order — dim → bright-bold
→ inverse → conceal → selection — at render rather than duplicating it.

**Appending is incremental.** `parseAnsi(chunk, { from: previous })` continues
a document rather than re-reading it, and a partial escape sequence at a
chunk boundary is _held_ — the same rule `<Markdown>` follows for an
ambiguous `---` tail. A growing log costs the tail, not the capture.

## What the flow reducer honours

- **SGR, in full**: 0, 1–9, 21–29, 30–37/40–47, 90–97/100–107, and 38/48 with
  both `5;n` and `2;r;g;b`, in the `;` and the `:` sub-parameter forms — so
  `4:3` (curly underline) and `58:2::r:g:b` (underline colour) work, which is
  the pair `@xterm/headless` does not expose and which AGENTS.md records as
  filed upstream. A static parser can simply read them.
- **`\r`, `\n`, `\b`, `\t`** — the four control characters a line-oriented
  stream actually uses. `\r` rewinds the write head _within the line_, so a
  shorter follow-up overwrites a prefix.
- **`\e[K` / `\e[1K` / `\e[2K`** — erase within the line. In a flow model this
  is exact: there is nothing past the head except what a `\r` rewind left, and
  erasing it is the whole point of the sequence.
- **`\e[nC` / `\e[nD` / `\e[nG`** — horizontal moves inside the line, which
  progress renderers use constantly and which are honest here. `\e[nG` is
  column-absolute _within a line_, which a flow model can answer exactly; it
  is the one addressing sequence that does not imply a screen.
- **OSC 8 hyperlinks** → `href`, which is already a `TextRun` field with
  `hrefAtPoint` behind it. `cargo`, `rustc`, `gcc`, `ls --hyperlink` and
  GitHub Actions all emit these, and they come out clickable through the same
  `onLink` shape `<Markdown>` uses.
- **OSC 0/1/2** → `document.title`.
- **`\e[nA` / `\e[nB` / `CUP` / `ED` / `DECSTBM` / the alternate screen** —
  these mean "a screen". They set `needsScreen` and are counted in `dropped`.
- Everything else — DEC private modes, mouse enables, DA queries, bracketed
  paste, OSC 52, and the Sixel / Kitty / iTerm2 image envelopes — is **parsed
  and discarded**. Parsed, not skipped: a parser that does not understand a
  sequence's structure prints its payload as text, which is the classic
  garbage-on-screen bug and the reason this is a state machine rather than a
  regular expression.

## Rendering, flow mode

One `<richtext>` for the whole document, in a horizontally scrolling
viewport, plus an optional `selectable={false}` line-number gutter — the
`<Code>` composition verbatim. Runs concatenate to exactly the visible text,
so drag, word and line selection, Ctrl+A, Ctrl+C and PRIMARY are core's with
no work here.

**Two additive changes in `src/richtext/`**, both found by reading the paint:

1. `TextRun.bg` is painted as a **chip** — inset −2/+4 horizontally and only
   ascent-to-descent tall. Right for `` `code ``, wrong for a terminal, where
   adjacent backgrounds must abut exactly and fill the line box. `bgFill?:
'chip' | 'line'` defaults to `'chip'`, so nothing existing moves.
2. `underline` was a single 1px rule. SGR `4:2` and `4:3` need double and
   curly, and `4:4`/`4:5` dotted and dashed. `underlineStyle?:` sits beside
   the existing colour field for the same reason: an existing caller that
   passes only a colour keeps the rule it had.

## Rendering, screen mode (phase 2)

Reuses `<vtterm>` whole: `new Terminal({cols, rows, scrollback})`,
`write(data)`, hand it over with no `onInput`. The palette, the signature
diff, the retained surface, the scrollback, selection and `serialize()` all
come along. `resizeToFit()` is already a no-op with `onGridResize` unset, and
paint already clamps to `term.cols`/`term.rows`, so only two element changes
are needed:

1. **`cursorStyle: 'none'`** — `'none'` is already a `CursorState['shape']`,
   but `_cursorState` forces `'hollow'` when unfocused, so a static snapshot
   currently draws a cursor outline. One short-circuit.
2. **`grid?: {cols, rows}`** — `measureContent` hardcodes 80×24 as the
   preferred size, so a 120×40 capture in an auto-sized box measures short.

**This needs `src/terminal/vt/`'s element half promoted to a shared module**
(`src/vtgrid/`: `node.ts`, `renderer.ts`, `fonts.ts`, `colors.ts`, `diff.ts`,
`xterm.ts`, plus an exported `registerVtGrid()`), leaving the _process_ half —
pty, flow control, restart, the handle — in `src/terminal/vt/index.ts`. "No
component imports another component" forbids the lateral import, and this is
the cut AGENTS.md already describes for `<glarea>`: ask which part stands on
the process and which stands on the element. It is `registerRichText()`'s
exact shape, and the same extraction `src/codeblock/` was when its second
consumer arrived.

That promotion is a refactor of shipped, tested code, which is why it is
phase 2 and not phase 1: flow mode is what a log needs, and a log is most
captures.

## Decisions rather than gaps

- **`\r` is honoured, and that is most of the value.** Every progress bar,
  spinner and `npm install` line is `\r` plus overwrite. A parser that treats
  `\r` as a newline turns a three-line install into nine hundred, and it is
  the single most visible thing this gets right or wrong.
- **Flow mode drops what it cannot mean, and counts it.** `document.dropped`
  names each sequence and how often it appeared. Silent divergence between
  what the terminal showed and what this drew is the failure that cannot be
  debugged from a screenshot.
- **`needsScreen` comes from the bytes.** No filename heuristics, no `$TERM`
  sniffing, no "looks like vim".
- **Screen mode does not get a second escape-sequence state machine.** A
  hand-written static replayer is tractable — perhaps 700 lines of
  CUP/ED/EL/IL/DL/ICH/DCH/ECH/DECSTBM/DECSC — and it would be a _second_ VT
  implementation in one package, drifting from the one under `<Terminal>`.
  That is the drift `src/codeblock/` was extracted to stop.
  `@xterm/headless` is already an optionalDependency that installs by default.
- **This is not a player.** `parseCast()` hands an app the events and their
  timings; `data` re-parses incrementally as it grows. Scheduling frames is
  the app's, and a component with a timer inside it never settles in a
  screenshot test.
- **No input, ever.** No `write()`, no key encoding, no mouse reporting, no
  OSC 52. A capture cannot answer a DA query, so nothing may ask it one — and
  OSC 52 in a capture is a _recording_ of a clipboard write, not a request to
  perform one.
- **The default background is the theme's, not black.** A capture rendered
  into a light app should not punch a dark rectangle into the page. `colors`
  takes the same `TerminalColors` `<Terminal>` takes, so an app that wants
  the terminal's own scheme asks for it, and a static pane and a live one
  agree when both are given the same prop.

**Rejected: `<Terminal backend="vt" replay={bytes}>`.** Mechanically the
smallest change — the vt path already builds an emulator and a `<vtterm>`, so
making the pty optional is about fifteen lines with no refactor at all.
Rejected because `<Terminal>`'s entire prop surface (`command`, `cwd`, `env`,
`backend`, `processes`, `pty`) is about running a program, and a mode in
which all of it is inert is a muddier API than a sibling component. `<Code>`
versus `<CodeEditor>` is the precedent this package already set.

## Deliberately not here

- **A player.** Above.
- **Sixel / Kitty / iTerm2 inline images.** Real in captures, and each is its
  own image decoder. The parser recognises and discards their envelopes so
  payloads never print as garbage, and `dropped` says so.
- **Reflow on resize in screen mode.** A capture was made at a grid;
  re-wrapping it invents content.
- **`minimumContrast`.** A real problem and a real feature (Windows Terminal,
  iTerm), and a follow-up rather than a first cut. It bites in both
  directions: grey-on-white from a capture authored for a dark terminal, and
  — visible in phase 1's own screenshots — ANSI 1 on a **dark** theme, where
  the default block fill is a faint tint of the ink rather than the
  near-black an ANSI palette was chosen against. `colors.background` is the
  answer today, and it is the right one when the capture is the point of the
  pane; a contrast floor is the answer when it is a detail in a page.
- **Blink.** SGR 5 is parsed and carried on the span; nothing animates it. A
  static render that repaints twice a second is not static.

## Testing

- The parser is pure, so `test/ansi.test.ts` asserts spans against byte
  strings with no display at all.
- **The text round-trip** is the assertion that catches the most: for an
  SGR-only capture, `doc.lines.map((l) => l.text).join('\n')` must equal the
  input with the escapes stripped. "No text was lost or invented" is then one
  case rather than an eyeball.
- The corpus is small real captures: `ls --color`, a `git diff --color`, an
  `npm install` progress run driven by `\r`, `cargo` with OSC 8, a `vim`
  session for `needsScreen`, and one cut mid-escape.
- Flow rendering is asserted through the mock backend, like `<Code>`: the
  runs reach the element, they concatenate to the text, the gutter stays out
  of the selection.
- Phase 2 compares screen mode against `<Terminal backend="vt">` fed the same
  bytes through `FakePtyHost` — same bytes, same pixels, which is the
  property that makes the reuse worth having.
