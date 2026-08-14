// A captured terminal session, as a document — the parser under
// `<TerminalOutput>`, and useful on its own.
//
// ```ts
// import { parseAnsi } from '@react-x11/components/ansi';
//
// const doc = parseAnsi(await readFile('build.log'));
// doc.lines.map((line) => line.text); // the text, escapes resolved away
// doc.needsScreen;                    // did these bytes want a grid?
// doc.dropped;                        // what could not be honoured
// ```
//
// **A shared module, not a component.** Nothing here registers an element,
// renders anything, or does any work at import time; there is no optional
// dependency and no `@xterm/headless`. It has a subpath of its own because
// "turn a log into styled text" is a thing to want without a terminal
// anywhere near it — colouring a build log inside a `<Markdown>` document,
// say, or stripping escapes before a diff.
//
// `docs/prd-terminal-output.md` is the design record: why a log is a document
// rather than a grid, and what that model can and cannot represent.
export { parseAnsi, stripAnsi, AnsiState } from './parse.js';
export type {
  AnsiDocument,
  AnsiInput,
  AnsiLine,
  AnsiSpan,
  ParseAnsiOptions,
} from './parse.js';

export { PLAIN, Style, ansiColor, rgbColor, param, ABSENT } from './sgr.js';
export type { AnsiAttrs, AnsiColor, AnsiUnderline } from './sgr.js';

export {
  ANSI_16,
  ansiPalette,
  cssColor,
  mixRgb,
  parseCssColor,
  resolveAnsiColors,
} from './palette.js';
export type {
  AnsiColorAttrs,
  AnsiPalette,
  AnsiPaletteOptions,
  ResolvedAnsiColors,
  Rgb,
} from './palette.js';

export { CastFormatError, castOutput, parseCast } from './cast.js';
export type { AnsiCast, AnsiCastEvent, AnsiCastHeader } from './cast.js';

export { Utf8Decoder } from './utf8.js';
