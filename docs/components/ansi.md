# ansi

```js
import { parseAnsi, stripAnsi, parseCast } from '@react-x11/components/ansi';
```

A captured terminal session, reduced to a document: the parser under
[`<TerminalOutput>`](terminal-output.md), and useful on its own.

**A shared module, not a component.** Nothing here registers an element,
renders anything, or does any work at import time; there is no React in it, no
optional dependency, and no `@xterm/headless`. It has a subpath of its own
because "turn a log into styled text" is a thing to want without a terminal
anywhere near it — colouring a build log inside a `<Markdown>` document, say,
or stripping escapes before a diff.

[The PRD](../prd-terminal-output.md) is the design record.

## The document

```ts
const doc = parseAnsi(await readFile('build.log'));

doc.lines; // AnsiLine[] — { spans, text }
doc.title; // the OSC 0/2 title, if the capture set one
doc.needsScreen; // did these bytes want a cell grid?
doc.dropped; // { CUP: 3, 'alt-screen': 1 } — what went unhonoured
doc.truncated; // lines evicted by maxLines
doc.state; // the resume point
```

A `AnsiLine` is `{ spans, text }`, and `text` is always the spans
concatenated — so `doc.lines.map((l) => l.text).join('\n')` is the capture as
plain text, which is what `stripAnsi` returns.

## Spans keep intent, not pixels

```ts
interface AnsiSpan {
  text: string;
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?;
  dim?;
  italic?;
  blink?;
  inverse?;
  conceal?;
  strike?;
  overline?: boolean;
  underline?: 'single' | 'double' | 'curly' | 'dotted' | 'dashed';
  underlineColor?: AnsiColor;
  href?: string; // OSC 8
}

type AnsiColor =
  | { kind: 'ansi'; index: number } // 0..255
  | { kind: 'rgb'; value: number }; // 0xRRGGBB
```

A field that is **absent** is the terminal's default — there is deliberately
no `null`, because "no background" and "the default background" are the same
statement and a renderer that has to tell them apart has a bug waiting in it.

A span says `{ kind: 'ansi', index: 2 }`, never `#00cd00`. Which pixels that
is belongs to a palette, and keeping the two apart is what lets one parsed
capture render correctly against a light theme and a dark one. It is the same
split `<Code>` makes between `codeRuns` (tokens) and `codeBlockLook` (the
palette).

## Turning intent into pixels

```ts
import { ansiPalette, resolveAnsiColors } from '@react-x11/components/ansi';

const palette = ansiPalette({ foreground: '#222', background: '#fff' });
resolveAnsiColors({ fg: { kind: 'ansi', index: 1 } }, palette);
// → { fg: '#cd0000' }   — no `bg`: the surface keeps its own
```

`ansiPalette` builds the 256 entries (the 16 from `palette` where it has one
and the standard set where it does not, then the 6×6×6 cube and the 24 greys,
both fixed by the protocol). `resolveAnsiColors` applies the transforms in the
order every terminal agrees on — bright-bold, dim, inverse, conceal — which is
the same order `<Terminal backend="vt">` applies to a live cell, so a capture
and the program that produced it look the same in one window.

**`bg` is absent when nothing claimed it.** That is what lets a log sit inside
a page instead of becoming an opaque strip.

## Appending

`parseAnsi(chunk, { from: previous })` continues a parse rather than starting
one, so a growing log costs the tail rather than the capture. A partial escape
sequence — or a UTF-8 character split by a chunk boundary — is **held**, not
mangled; that is the same rule `PtyHost.onData` carries for the live terminal
and `<Markdown>` follows for an unterminated tail.

```ts
let doc = parseAnsi(first);
doc = parseAnsi(second, { from: doc });
```

Earlier snapshots stay valid: completed lines are never mutated.

## asciinema recordings

```ts
import { parseCast, castOutput, parseAnsi } from '@react-x11/components/ansi';

const cast = parseCast(await readFile('session.cast', 'utf8'));
cast.header; // { version, width, height, title?, timestamp?, env? }
cast.events; // [{ time, kind, data }] — absolute times, v1's deltas included

parseAnsi(castOutput(cast, { until: 12.5 })); // the session at 12.5s
```

Both published versions are read. A malformed _event_ line is skipped — a
recording still being written has a partial last line — while a missing header
throws `CastFormatError`, because without one there is no recording.

`castOutput` takes only `'o'` events: input, resize and marker events have no
pixels.

## API

| Export                                     | What it is                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `parseAnsi(data, options?)`                | Bytes → `AnsiDocument`. `options`: `from`, `tabWidth`, `maxLines`.                              |
| `stripAnsi(data, options?)`                | The capture's text, escapes resolved away.                                                      |
| `AnsiState`                                | The reducer state. `doc.state` is one; construct one to drive it.                               |
| `ansiPalette(options?)`                    | The 256-colour palette from `foreground`/`background`/`palette`.                                |
| `resolveAnsiColors(attrs, palette)`        | A span's two colours, after every transform that can change them.                               |
| `ansiColor(i)` / `rgbColor(r, g, b)`       | Colour constructors. Indexed colours are interned.                                              |
| `parseCssColor` / `cssColor` / `mixRgb`    | The colour arithmetic, exported because a caller building its own palette needs the same three. |
| `parseCast(text)` / `castOutput(cast, o?)` | asciinema v1 and v2.                                                                            |
| `Style` / `PLAIN` / `param` / `ABSENT`     | The SGR reducer's own parts, for a caller driving the machine itself.                           |
| `Utf8Decoder`                              | A decoder that survives a chunk boundary.                                                       |
| `ANSI_16`                                  | The standard sixteen, as xterm defines them.                                                    |

## What the model can and cannot say

Honoured exactly: SGR in full (the 16, the 256 cube, truecolor, and the `:`
sub-parameter forms — so `4:3` curly underlines and `58` underline colours
work, which is the pair `@xterm/headless` does not expose); `\r`, `\n`, `\b`,
`\t`; `\e[K`/`1K`/`2K`; `\e[nC`/`nD`/`nG` inside a line; `\e[nX`/`nP`/`n@`;
OSC 8 hyperlinks; OSC 0/2 titles.

Dropped and counted: cursor addressing, `ED`, `IL`/`DL`, scroll regions, the
alternate screen, DEC private modes, device queries, OSC 52, and Sixel /
Kitty / iTerm2 image envelopes. Every one of them is **recognised and
consumed** even where it is discarded — a parser that does not understand a
sequence's structure prints its payload as text, which is the classic
garbage-on-screen bug.

Two model limits worth knowing: **East Asian wide characters take one column
rather than two**, which only matters when a capture rewinds past CJK text
with `\r` or `\e[nG` and never affects the text itself; and a **combining mark
joins the cell before it** rather than taking one of its own, so an accent
does not shift every column after it.
