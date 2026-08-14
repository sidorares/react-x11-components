// The escape-sequence state machine, and the flow reducer over it.
//
// Pure: bytes in, plain arrays out. No X, no node, no React, no
// `@xterm/headless` — so the whole model is asserted against byte strings in
// `test/ansi.test.ts`, the posture `../terminal/vt/diff.ts` takes for the
// live renderer.
//
// ### Why a line buffer rather than a grid
//
// A log is a *document*: it has lines, not rows, and no column count of its
// own. So the reducer keeps exactly one row — the line being written — and
// flushes it to spans when a newline arrives. `\r` rewinds the write head
// inside that row, `\e[K` truncates it, `\e[nC` moves along it: every
// sequence a line-oriented program actually emits is exact in this model,
// while none of them needs a `cols` the capture never had.
//
// The sequences that only mean something on a real screen — `CUP`, `ED`,
// `IL`, a scroll region, the alternate screen — set `needsScreen` and are
// counted in `dropped`. What this cannot represent, it says so about; see
// the PRD for why silence would be the worse failure.
//
// ### Why a state machine rather than a regular expression
//
// A parser that does not understand a sequence's *structure* prints its
// payload as text the moment it meets one it has no pattern for — the
// classic garbage-on-screen bug. Everything below is recognised and consumed
// even when it is then discarded.
import { PLAIN, Style, param, ABSENT } from './sgr.js';
import type { AnsiAttrs } from './sgr.js';
import { Utf8Decoder } from './utf8.js';

/** One run of characters sharing every attribute. */
export type AnsiSpan = AnsiAttrs & { readonly text: string };

/** One line of the capture. `text` is the spans concatenated. */
export interface AnsiLine {
  readonly spans: readonly AnsiSpan[];
  readonly text: string;
}

/** What a capture reduces to. A plain immutable value — snapshot it, keep it,
 *  hand it to React. */
export interface AnsiDocument {
  readonly lines: readonly AnsiLine[];
  /** The last title the capture set, through OSC 0 or OSC 2. */
  readonly title?: string;
  /** The stream addressed the cursor absolutely, scrolled a region, or
   *  entered the alternate screen: these bytes wanted a grid. */
  readonly needsScreen: boolean;
  /** What could not be honoured, by name, with counts. */
  readonly dropped: Readonly<Record<string, number>>;
  /** Lines evicted by `maxLines`, oldest first. */
  readonly truncated: number;
  /** The resume point. Pass the document back as `from` to continue. */
  readonly state: AnsiState;
}

export type AnsiInput = string | Uint8Array | readonly (string | Uint8Array)[];

export interface ParseAnsiOptions {
  /** Continue a previous parse rather than starting one. A partial escape
   *  sequence or a half-arrived UTF-8 character at the boundary is held, not
   *  mangled — the same rule `<Markdown>` follows for an unterminated tail. */
  from?: AnsiDocument | AnsiState;
  /** Default 8, the terminal's. */
  tabWidth?: number;
  /** Keep only the last N lines, dropping from the front. Unbounded by
   *  default: the app read the file, so the app decided how big it is. */
  maxLines?: number;
}

/**
 * A capture, reduced.
 *
 * ```ts
 * const doc = parseAnsi(await readFile('build.log'));
 * doc.lines.map((line) => line.text);
 * ```
 */
export function parseAnsi(
  data: AnsiInput,
  options: ParseAnsiOptions = {},
): AnsiDocument {
  const state =
    options.from instanceof AnsiState
      ? options.from
      : options.from
        ? options.from.state
        : new AnsiState(options);
  state.write(data);
  return state.snapshot();
}

/** The capture's text with every escape sequence resolved away. What a
 *  round-trip test compares against, and what a plain-text export wants. */
export function stripAnsi(data: AnsiInput, options?: ParseAnsiOptions): string {
  return parseAnsi(data, options)
    .lines.map((line) => line.text)
    .join('\n');
}

// --- the machine ------------------------------------------------------------

const GROUND = 0;
const ESC = 1;
const CSI = 2;
const OSC = 3;
/** DCS, SOS, PM, APC — a string terminated by ST, and never anything we draw. */
const STR = 4;
/** `ESC ( B` and friends: one more byte to swallow. */
const CHARSET = 5;

/** A column an escape sequence may ask for. `\e[999999999C` is a corrupt
 *  capture rather than a request, and allocating for it is how a renderer
 *  turns one bad byte into an out-of-memory. */
const MAX_COLUMN = 100_000;
/** An OSC or DCS payload bigger than this is a program misbehaving — the same
 *  call `<vtterm>` makes about an oversized OSC 52. */
const MAX_STRING = 64 * 1024;

/** Marks join the cell before them rather than taking one of their own, so a
 *  combining accent does not shift every column after it. */
const MARK = /\p{M}/u;
const ZWJ = 0x200d;

function joinsPrevious(cp: number, ch: string): boolean {
  return cp === ZWJ || (cp >= 0x300 && MARK.test(ch));
}

/** Would a blank cell in these attributes leave a mark on the screen? */
function paintsBlank(attrs: AnsiAttrs | undefined): boolean {
  if (!attrs || attrs === PLAIN) return false;
  return Boolean(
    attrs.bg ??
    attrs.inverse ??
    attrs.underline ??
    attrs.strike ??
    attrs.overline,
  );
}

/**
 * One row of cells, as spans.
 *
 * Trailing blanks in attributes that paint nothing are dropped: they are
 * invisible on the screen and they would ride along in every copied line. A
 * trailing run that *does* paint — a status bar's background — is kept,
 * because that one is on the screen.
 */
function flushLine(
  chars: readonly string[],
  attrs: readonly (AnsiAttrs | undefined)[],
): AnsiLine {
  let end = chars.length;
  while (
    end > 0 &&
    (chars[end - 1] ?? ' ') === ' ' &&
    !paintsBlank(attrs[end - 1])
  ) {
    end--;
  }
  const spans: AnsiSpan[] = [];
  let text = '';
  let i = 0;
  while (i < end) {
    // Cells written between two SGR sequences share one frozen record, so
    // this is an identity compare rather than twelve field compares.
    const attr = attrs[i] ?? PLAIN;
    let j = i + 1;
    while (j < end && (attrs[j] ?? PLAIN) === attr) j++;
    let run = '';
    for (let k = i; k < j; k++) run += chars[k] ?? ' ';
    spans.push({ ...attr, text: run });
    text += run;
    i = j;
  }
  return { spans, text };
}

/**
 * The reducer's state: the escape machine, the current attributes, the line
 * being written, and the lines already finished.
 *
 * Held across calls so an append costs the appended bytes. Completed lines
 * are never mutated, so an older `AnsiDocument` snapshot stays valid after
 * the next `write()`.
 */
export class AnsiState {
  private readonly _tabWidth: number;
  private readonly _maxLines: number;

  private _style = new Style();
  private _decoder = new Utf8Decoder();

  private _lines: AnsiLine[] = [];
  private _truncated = 0;

  private _chars: string[] = [];
  private _attrs: (AnsiAttrs | undefined)[] = [];
  private _col = 0;
  private _lastPrinted = '';
  private _joinNext = false;

  private _title: string | undefined;
  private _needsScreen = false;
  private _dropped: Record<string, number> = {};

  private _phase = GROUND;
  private _params: number[][] = [];
  private _group: number[] = [];
  private _digits = '';
  private _prefix = '';
  private _string = '';
  private _stringEsc = false;

  constructor(options: { tabWidth?: number; maxLines?: number } = {}) {
    this._tabWidth = Math.max(1, options.tabWidth ?? 8);
    this._maxLines = Math.max(1, options.maxLines ?? Infinity);
  }

  /** Feed the next chunk. Bytes are preferred — see `./utf8.ts`. */
  write(data: AnsiInput): void {
    if (typeof data === 'string') {
      this._feed(data);
      return;
    }
    if (data instanceof Uint8Array) {
      this._feed(this._decoder.decode(data));
      return;
    }
    for (const part of data) this.write(part);
  }

  /** The document as it stands. Cheap: only the line still being written is
   *  rebuilt, and the finished ones are shared by reference. */
  snapshot(): AnsiDocument {
    const live = flushLine(this._chars, this._attrs);
    // A capture with no trailing newline still has a last line, and a log
    // being tailed shows its tail. An empty one is not a line at all.
    const hasLive = live.spans.length > 0;
    // The line still being written counts against `maxLines`, because "keep
    // the last hundred lines" means the hundred a reader sees. Eviction in
    // `_pushLine` is what bounds the memory; this is what bounds the answer,
    // and only the two differ by the one live line.
    const room = hasLive ? this._maxLines - 1 : this._maxLines;
    const skipped = Math.max(0, this._lines.length - room);
    const lines =
      skipped > 0 ? this._lines.slice(skipped) : this._lines.slice();
    if (hasLive) lines.push(live);
    return {
      lines,
      ...(this._title === undefined ? null : { title: this._title }),
      needsScreen: this._needsScreen,
      dropped: { ...this._dropped },
      truncated: this._truncated + skipped,
      state: this,
    };
  }

  // --- the escape machine ---------------------------------------------------

  private _feed(text: string): void {
    const n = text.length;
    let i = 0;
    while (i < n) {
      if (this._phase === GROUND) {
        // The fast path: everything up to the next control character is text,
        // and a build log is almost all text.
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c < 0x20 || c === 0x7f) break;
          j++;
        }
        if (j > i) {
          this._print(text.slice(i, j));
          i = j;
          continue;
        }
        this._control(text.charCodeAt(i));
        i++;
        continue;
      }
      this._step(text.charCodeAt(i), text[i]!);
      i++;
    }
  }

  private _control(c: number): void {
    switch (c) {
      case 0x08:
        this._col = Math.max(0, this._col - 1);
        break;
      case 0x09:
        this._col = Math.min(
          MAX_COLUMN,
          (Math.floor(this._col / this._tabWidth) + 1) * this._tabWidth,
        );
        break;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this._newline();
        break;
      case 0x0d:
        this._col = 0;
        break;
      case 0x1b:
        this._phase = ESC;
        break;
      default:
        // BEL, SO/SI, DEL and the rest: consumed, and none of them changes
        // anything this model holds.
        break;
    }
  }

  private _step(code: number, ch: string): void {
    switch (this._phase) {
      case ESC:
        this._escape(ch);
        break;
      case CSI:
        this._csi(code, ch);
        break;
      case OSC:
      case STR:
        this._stringByte(code, ch);
        break;
      case CHARSET:
        // `ESC ( B` and its family: the designation byte, swallowed. Nothing
        // here switches character sets — a capture is already Unicode by the
        // time it reaches this parser.
        this._phase = GROUND;
        break;
      default:
        this._phase = GROUND;
        break;
    }
  }

  private _escape(ch: string): void {
    switch (ch) {
      case '[':
        this._phase = CSI;
        this._params = [];
        this._group = [];
        this._digits = '';
        this._prefix = '';
        return;
      case ']':
        this._phase = OSC;
        this._string = '';
        this._stringEsc = false;
        return;
      case 'P': // DCS — sixel arrives here
      case 'X': // SOS
      case '^': // PM
      case '_': // APC
        this._phase = STR;
        this._string = '';
        this._stringEsc = false;
        return;
      case '(':
      case ')':
      case '*':
      case '+':
      case '-':
      case '.':
      case '/':
      case '#':
      case '%':
      case ' ':
        this._phase = CHARSET;
        return;
      default:
        break;
    }
    this._phase = GROUND;
    switch (ch) {
      case 'D': // IND — down one line
        this._newline();
        break;
      case 'E': // NEL — down one line, column zero
        this._newline();
        break;
      case 'M': // RI — *up* one line, which only a screen has
        this._screen('RI');
        break;
      case '7':
      case '8':
        // DECSC/DECRC. Counted rather than flagged: a saved cursor restored
        // inside one line is ordinary in progress renderers, and calling
        // every capture that uses it "needs a screen" would cry wolf.
        this._drop(ch === '7' ? 'DECSC' : 'DECRC');
        break;
      case 'c':
        this._drop('RIS');
        break;
      case '\\': // ST with nothing open
      case '=':
      case '>':
        break;
      default:
        this._drop('esc');
        break;
    }
  }

  private _csi(code: number, ch: string): void {
    if (code >= 0x30 && code <= 0x39) {
      this._digits += ch;
      return;
    }
    if (code === 0x3a) {
      this._group.push(this._value());
      return;
    }
    if (code === 0x3b) {
      this._group.push(this._value());
      this._params.push(this._group);
      this._group = [];
      return;
    }
    if (code >= 0x3c && code <= 0x3f) {
      // `?`, `<`, `=`, `>`: the private marker, and only legal before any
      // parameter — a stray one later is the capture's problem, not ours.
      this._prefix += ch;
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      // An intermediate byte. Nothing dispatched below takes one, so the only
      // thing it changes is that the final is not what it would otherwise be.
      this._prefix += ch;
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      this._group.push(this._value());
      this._params.push(this._group);
      this._group = [];
      this._phase = GROUND;
      this._dispatch(ch);
      return;
    }
    if (code === 0x18 || code === 0x1a) {
      // CAN/SUB abort the sequence, which is the one way a program says
      // "ignore what I just started".
      this._phase = GROUND;
      return;
    }
    // A C0 inside a CSI is executed and the sequence continues, which is what
    // makes `\e[1;\n31m` behave the way a terminal behaves.
    if (code < 0x20) this._control(code);
  }

  private _value(): number {
    if (!this._digits) return ABSENT;
    const n = Number.parseInt(this._digits, 10);
    this._digits = '';
    return Number.isFinite(n) ? n : ABSENT;
  }

  private _dispatch(final: string): void {
    const params = this._params;
    const at = (i: number, dflt: number): number => param(params, i, dflt);
    const positive = (i: number): number =>
      Math.max(1, Math.min(MAX_COLUMN, at(i, 1)));

    if (this._prefix) {
      this._private(final, at(0, 0));
      return;
    }

    switch (final) {
      case 'm':
        this._style.apply(params);
        return;
      case 'K':
        this._eraseLine(at(0, 0));
        return;
      case 'C': // CUF
      case 'a': // HPR
        this._col = Math.min(MAX_COLUMN, this._col + positive(0));
        return;
      case 'D': // CUB
        this._col = Math.max(0, this._col - positive(0));
        return;
      case 'G': // CHA
      case '`': // HPA
        // Column-absolute *within a line* is the one addressing sequence a
        // flow model answers exactly, so it is honoured rather than flagged.
        this._col = Math.max(0, Math.min(MAX_COLUMN, at(0, 1) - 1));
        return;
      case 'E': // CNL — down n lines, column zero. In a document, n newlines.
        for (let i = 0; i < positive(0); i++) this._newline();
        return;
      case 'Z': // CBT
        this._col = Math.max(
          0,
          (Math.ceil(this._col / this._tabWidth) - positive(0)) *
            this._tabWidth,
        );
        return;
      case 'X': // ECH
        this._eraseChars(positive(0));
        return;
      case 'P': // DCH
        this._deleteChars(positive(0));
        return;
      case '@': // ICH
        this._insertBlanks(positive(0));
        return;
      case 'b': // REP
        if (this._lastPrinted) {
          const attrs = this._style.attrs();
          for (let i = 0; i < positive(0); i++)
            this._put(this._lastPrinted, attrs);
        }
        return;
      case 'H':
      case 'f':
        this._screen('CUP');
        return;
      case 'A':
        this._screen('CUU');
        return;
      case 'B':
        this._screen('CUD');
        return;
      case 'F':
        this._screen('CPL');
        return;
      case 'd':
        this._screen('VPA');
        return;
      case 'J':
        this._screen('ED');
        return;
      case 'L':
        this._screen('IL');
        return;
      case 'M':
        this._screen('DL');
        return;
      case 'S':
        this._screen('SU');
        return;
      case 'T':
        this._screen('SD');
        return;
      case 'r':
        this._screen('DECSTBM');
        return;
      case 'n':
      case 'c':
        // A query. Nothing can answer it: a capture is not a conversation.
        this._drop('query');
        return;
      case 'h':
      case 'l':
        this._drop('mode');
        return;
      case 's':
      case 'u':
        this._drop(final === 's' ? 'SCOSC' : 'SCORC');
        return;
      case 't':
        this._drop('window-op');
        return;
      default:
        this._drop('csi');
        return;
    }
  }

  private _private(final: string, first: number): void {
    if (final !== 'h' && final !== 'l') {
      this._drop('csi-private');
      return;
    }
    // 1049/1047/47 are the alternate screen, and a program that took it drew
    // a screen by definition.
    if (first === 1049 || first === 1047 || first === 47) {
      this._screen('alt-screen');
      return;
    }
    // Cursor visibility, bracketed paste, mouse tracking, focus reporting:
    // all real, none of them visible in a static render.
    this._drop('dec-mode');
  }

  // --- OSC and the string sequences -----------------------------------------

  private _stringByte(code: number, ch: string): void {
    if (this._stringEsc) {
      this._stringEsc = false;
      if (ch === '\\') {
        this._endString();
        return;
      }
      // An ESC that was not ST aborts the string, exactly as it does in a
      // terminal — otherwise one dropped byte swallows the rest of the log.
      this._phase = GROUND;
      this._escape(ch);
      return;
    }
    if (code === 0x1b) {
      this._stringEsc = true;
      return;
    }
    if (code === 0x07) {
      this._endString();
      return;
    }
    if (code < 0x20) {
      // A C0 other than BEL/ESC ends an OSC in xterm. Ending is the safe
      // reading: the alternative is swallowing the rest of the capture.
      this._endString();
      this._control(code);
      return;
    }
    if (this._string.length < MAX_STRING) this._string += ch;
  }

  private _endString(): void {
    const phase = this._phase;
    const payload = this._string;
    this._string = '';
    this._phase = GROUND;
    if (phase === STR) {
      // DCS and friends. Sixel lives here, and a sixel is an image this
      // component does not decode — recognised, consumed, counted.
      this._drop(/^[\d;]*q/.test(payload) ? 'sixel' : 'dcs');
      return;
    }
    const split = payload.indexOf(';');
    const id = split < 0 ? payload : payload.slice(0, split);
    const rest = split < 0 ? '' : payload.slice(split + 1);
    switch (id) {
      case '0':
      case '2':
        this._title = rest;
        return;
      case '1':
        // The icon name. Real, and nothing here has an icon.
        return;
      case '8': {
        // `OSC 8 ; params ; URI ST`, and an empty URI closes.
        const uriAt = rest.indexOf(';');
        const uri = uriAt < 0 ? '' : rest.slice(uriAt + 1);
        this._style.setHref(uri || undefined);
        return;
      }
      case '52':
        // A recorded clipboard write. Recording one is not performing one.
        this._drop('osc-52');
        return;
      case '4':
      case '10':
      case '11':
      case '12':
      case '104':
      case '110':
      case '111':
      case '112':
        this._drop('osc-palette');
        return;
      default:
        this._drop('osc');
        return;
    }
  }

  // --- the line buffer ------------------------------------------------------

  private _print(text: string): void {
    const attrs = this._style.attrs();
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const joins = this._joinNext || joinsPrevious(cp, ch);
      this._joinNext = cp === ZWJ;
      if (joins && this._col > 0) {
        const at = this._col - 1;
        this._chars[at] = (this._chars[at] ?? ' ') + ch;
        this._lastPrinted = this._chars[at]!;
        continue;
      }
      this._put(ch, attrs);
    }
  }

  private _put(ch: string, attrs: AnsiAttrs): void {
    const col = this._col;
    if (col >= MAX_COLUMN) return;
    // A gap opened by CUF or HPA is blank on the screen, so it is blank here.
    for (let i = this._chars.length; i < col; i++) {
      this._chars[i] = ' ';
      this._attrs[i] = PLAIN;
    }
    this._chars[col] = ch;
    this._attrs[col] = attrs;
    this._col = col + 1;
    this._lastPrinted = ch;
  }

  private _newline(): void {
    this._pushLine(flushLine(this._chars, this._attrs));
    this._chars = [];
    this._attrs = [];
    this._col = 0;
    this._joinNext = false;
  }

  private _pushLine(line: AnsiLine): void {
    this._lines.push(line);
    if (this._lines.length > this._maxLines) {
      const excess = this._lines.length - this._maxLines;
      this._lines.splice(0, excess);
      this._truncated += excess;
    }
  }

  private _eraseLine(mode: number): void {
    if (mode === 1) {
      const attrs = this._style.attrs();
      const end = Math.min(
        this._col + 1,
        Math.max(this._chars.length, this._col + 1),
      );
      for (let i = 0; i < end; i++) {
        this._chars[i] = ' ';
        this._attrs[i] = attrs;
      }
      return;
    }
    // 0 truncates from the head, 2 clears the row. In a document both are the
    // same statement — there is nothing past the head but what a `\r` rewind
    // left, and erasing it is exactly what the sequence is for.
    const from = mode === 2 ? 0 : this._col;
    this._chars.length = Math.min(this._chars.length, from);
    this._attrs.length = Math.min(this._attrs.length, from);
  }

  private _eraseChars(n: number): void {
    const attrs = this._style.attrs();
    const end = Math.min(this._chars.length, this._col + n);
    for (let i = this._col; i < end; i++) {
      this._chars[i] = ' ';
      this._attrs[i] = attrs;
    }
  }

  private _deleteChars(n: number): void {
    if (this._col >= this._chars.length) return;
    this._chars.splice(this._col, n);
    this._attrs.splice(this._col, n);
  }

  private _insertBlanks(n: number): void {
    if (this._col > this._chars.length) return;
    const attrs = this._style.attrs();
    const blanks = new Array<string>(n).fill(' ');
    this._chars.splice(this._col, 0, ...blanks);
    this._attrs.splice(this._col, 0, ...new Array<AnsiAttrs>(n).fill(attrs));
  }

  // --- what could not be honoured -------------------------------------------

  private _drop(name: string): void {
    this._dropped[name] = (this._dropped[name] ?? 0) + 1;
  }

  /** Dropped, and it is the kind of sequence that means the capture wanted a
   *  real screen. Both, always: `needsScreen` says which renderer to use and
   *  `dropped` says what it cost to use the other one. */
  private _screen(name: string): void {
    this._needsScreen = true;
    this._drop(name);
  }
}
