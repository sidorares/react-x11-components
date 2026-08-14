// The ANSI parser: pure, so all of it is asserted against byte strings with
// no display anywhere. What is tested here is the *model* — which sequences
// become spans, which become nothing and say so, and what `\r` does — not how
// any of it is painted; that is `terminal-output.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  ansiPalette,
  castOutput,
  parseAnsi,
  parseCast,
  resolveAnsiColors,
  stripAnsi,
} from '../src/index.js';
import type { AnsiDocument, AnsiSpan } from '../src/index.js';

const ESC = '\u001b';

function spansOf(doc: AnsiDocument, line = 0): readonly AnsiSpan[] {
  return doc.lines[line]?.spans ?? [];
}

// --- the text round trip ----------------------------------------------------
//
// The assertion that catches the most: for an SGR-only capture the text must
// come back exactly, so "no text was lost or invented" is one case rather
// than an eyeball over a screenshot.

test('an SGR-only capture round-trips to its text', () => {
  const source =
    `${ESC}[1;32m✓${ESC}[0m 42 tests passed\n` +
    `${ESC}[31m✗${ESC}[0m 1 failed: ${ESC}[4mfoo.test.ts${ESC}[24m\n` +
    `${ESC}[38;5;208mwarn${ESC}[39m  unused import\n`;
  const plain = source.replace(/\[[0-9;:]*m/g, '');
  assert.equal(stripAnsi(source), plain.replace(/\n$/, ''));
});

test('the runs concatenate to the line text', () => {
  const doc = parseAnsi(`${ESC}[1mbold${ESC}[0m and ${ESC}[31mred${ESC}[0m`);
  for (const line of doc.lines) {
    assert.equal(
      line.spans.map((s) => s.text).join(''),
      line.text,
      'spans concatenate to the line',
    );
  }
});

test('plain text needs no escape at all', () => {
  const doc = parseAnsi('one\ntwo\nthree');
  assert.equal(doc.lines.length, 3);
  assert.deepEqual(
    doc.lines.map((l) => l.text),
    ['one', 'two', 'three'],
  );
  assert.equal(doc.needsScreen, false);
  assert.deepEqual(doc.dropped, {});
});

test('an empty capture has no lines, and a trailing newline adds none', () => {
  assert.equal(parseAnsi('').lines.length, 0);
  assert.equal(parseAnsi('one\n').lines.length, 1);
  assert.equal(parseAnsi('one\n\n').lines.length, 2);
});

// --- SGR --------------------------------------------------------------------

test('colours are kept as intent, not as pixels', () => {
  const doc = parseAnsi(`${ESC}[32mgreen${ESC}[0m`);
  assert.deepEqual(spansOf(doc)[0], {
    fg: { kind: 'ansi', index: 2 },
    text: 'green',
  });
});

test('the bright pairs, the 256 cube and truecolor all arrive', () => {
  const doc = parseAnsi(
    `${ESC}[91ma${ESC}[38;5;208mb${ESC}[38;2;255;128;0mc${ESC}[0m`,
  );
  const spans = spansOf(doc);
  assert.deepEqual(spans[0]!.fg, { kind: 'ansi', index: 9 });
  assert.deepEqual(spans[1]!.fg, { kind: 'ansi', index: 208 });
  assert.deepEqual(spans[2]!.fg, { kind: 'rgb', value: 0xff8000 });
});

test('the colon sub-parameter forms are read too', () => {
  // `38:2::r:g:b` — the ITU form, with the colour-space slot left empty.
  const withSpace = parseAnsi(`${ESC}[38:2::12:34:56mx`);
  assert.deepEqual(spansOf(withSpace)[0]!.fg, { kind: 'rgb', value: 0x0c2238 });
  const without = parseAnsi(`${ESC}[38:2:12:34:56mx`);
  assert.deepEqual(spansOf(without)[0]!.fg, { kind: 'rgb', value: 0x0c2238 });
  const indexed = parseAnsi(`${ESC}[38:5:208mx`);
  assert.deepEqual(spansOf(indexed)[0]!.fg, { kind: 'ansi', index: 208 });
});

test('SGR 4 carries its underline style, and 24 turns it off', () => {
  const doc = parseAnsi(
    `${ESC}[4ma${ESC}[4:3mb${ESC}[21mc${ESC}[24md${ESC}[0m`,
  );
  const spans = spansOf(doc);
  assert.equal(spans[0]!.underline, 'single');
  assert.equal(spans[1]!.underline, 'curly');
  // 21 is double underline in every terminal a capture was made on, whatever
  // ECMA-48 says.
  assert.equal(spans[2]!.underline, 'double');
  assert.equal(spans[3]!.underline, undefined);
});

test('SGR 58 gives the underline its own colour', () => {
  const doc = parseAnsi(`${ESC}[4:3;58:2::255:0:0mbad${ESC}[0m`);
  const [span] = spansOf(doc);
  assert.equal(span!.underline, 'curly');
  assert.deepEqual(span!.underlineColor, { kind: 'rgb', value: 0xff0000 });
});

test('an empty SGR parameter is a reset', () => {
  const doc = parseAnsi(`${ESC}[31mred${ESC}[mplain`);
  const spans = spansOf(doc);
  assert.deepEqual(spans[0]!.fg, { kind: 'ansi', index: 1 });
  assert.equal(spans[1]!.fg, undefined);
});

test('every attribute a terminal sets survives to the span', () => {
  const doc = parseAnsi(`${ESC}[1;2;3;5;7;8;9;53mall${ESC}[0m`);
  const [span] = spansOf(doc);
  assert.deepEqual(
    { ...span },
    {
      text: 'all',
      bold: true,
      dim: true,
      italic: true,
      blink: true,
      inverse: true,
      conceal: true,
      strike: true,
      overline: true,
    },
  );
});

test('runs coalesce while nothing changes', () => {
  const doc = parseAnsi(`${ESC}[31mabc${ESC}[31mdef${ESC}[0m`);
  assert.equal(spansOf(doc).length, 1, 'a redundant SGR does not split a run');
  assert.equal(spansOf(doc)[0]!.text, 'abcdef');
});

// --- the control characters that carry a log --------------------------------

test('carriage return rewinds inside the line: a progress bar is one line', () => {
  const doc = parseAnsi('  0%\r 50%\r100%\ndone');
  assert.deepEqual(
    doc.lines.map((l) => l.text),
    ['100%', 'done'],
  );
});

test('an overwrite shorter than what it replaces leaves the tail behind', () => {
  // Exactly why `\e[K` exists, and exactly what a renderer that "helpfully"
  // truncates would hide.
  const doc = parseAnsi('installing...\rdone');
  assert.equal(doc.lines[0]!.text, 'donealling...');
});

test('and `\\e[K` is what clears it', () => {
  const doc = parseAnsi(`installing...\rdone${ESC}[K`);
  assert.equal(doc.lines[0]!.text, 'done');
});

test('backspace and tab move the write head', () => {
  assert.equal(parseAnsi('abcX\b\bYZ').lines[0]!.text, 'abYZ');
  assert.equal(parseAnsi('a\tb').lines[0]!.text, 'a       b');
  assert.equal(parseAnsi('a\tb', { tabWidth: 4 }).lines[0]!.text, 'a   b');
});

test('a gap opened by CUF is blank, not missing', () => {
  const doc = parseAnsi(`a${ESC}[4Cb`);
  assert.equal(doc.lines[0]!.text, 'a    b');
});

test('CHA is column-absolute inside the line, and is honoured', () => {
  const doc = parseAnsi(`hello${ESC}[1Gbye`);
  assert.equal(doc.lines[0]!.text, 'byelo');
  assert.equal(doc.needsScreen, false, 'a column is not a screen');
});

test('trailing blanks are dropped unless something paints them', () => {
  assert.equal(parseAnsi('text     ').lines[0]!.text, 'text');
  const bar = parseAnsi(`text${ESC}[41m     ${ESC}[0m`);
  assert.equal(bar.lines[0]!.text, 'text     ', 'a red run is on the screen');
});

// --- what a document cannot say ---------------------------------------------

test('addressing the cursor sets needsScreen and is counted', () => {
  const doc = parseAnsi(`${ESC}[2J${ESC}[3;10Hhi`);
  assert.equal(doc.needsScreen, true);
  assert.deepEqual(doc.dropped, { ED: 1, CUP: 1 });
});

test('the alternate screen is the loudest signal there is', () => {
  const doc = parseAnsi(`${ESC}[?1049h${ESC}[?25lvim${ESC}[?1049l`);
  assert.equal(doc.needsScreen, true);
  assert.equal(doc.dropped['alt-screen'], 2);
  assert.equal(doc.dropped['dec-mode'], 1, 'cursor hiding is not a screen');
});

test('an ordinary log flags nothing', () => {
  const doc = parseAnsi(
    `${ESC}[1;32mPASS${ESC}[0m src/a.test.ts\r\n` +
      `${ESC}[1;31mFAIL${ESC}[0m src/b.test.ts\r\n`,
  );
  assert.equal(doc.needsScreen, false);
  assert.deepEqual(doc.dropped, {});
});

test('sequences with no meaning here are consumed, never printed', () => {
  // The classic garbage-on-screen bug: a parser with no pattern for a
  // sequence prints its payload as text.
  const doc = parseAnsi(
    `a${ESC}[?2004hb${ESC}]52;c;aGVsbG8=c${ESC}P0;1q#0;2;0;0;0${ESC}\\d${ESC}[6nf`,
  );
  assert.equal(doc.lines[0]!.text, 'abcdf');
  assert.equal(doc.dropped['osc-52'], 1);
  assert.equal(doc.dropped['sixel'], 1);
  assert.equal(doc.dropped['query'], 1);
});

// --- OSC --------------------------------------------------------------------

test('OSC 8 hyperlinks become an href on the span', () => {
  const doc = parseAnsi(
    `see ${ESC}]8;;https://example.com/xthe docs${ESC}]8;; for more`,
  );
  const spans = spansOf(doc);
  assert.deepEqual(
    spans.map((s) => [s.text, s.href]),
    [
      ['see ', undefined],
      ['the docs', 'https://example.com/x'],
      [' for more', undefined],
    ],
  );
});

test('a hyperlink survives an SGR reset inside it', () => {
  // OSC 8 is its own state: a program that colours part of a link has not
  // ended the link.
  const doc = parseAnsi(
    `${ESC}]8;;https://example.com${ESC}\\${ESC}[31mred${ESC}[0mplain${ESC}]8;;${ESC}\\`,
  );
  assert.deepEqual(
    spansOf(doc).map((s) => s.href),
    ['https://example.com', 'https://example.com'],
  );
});

test('OSC 0 and 2 set the title', () => {
  assert.equal(parseAnsi(`${ESC}]0;npm testx`).title, 'npm test');
  assert.equal(parseAnsi(`${ESC}]2;bash${ESC}\\x`).title, 'bash');
  assert.equal(parseAnsi('x').title, undefined);
});

// --- appending --------------------------------------------------------------

test('appending continues rather than re-reading', () => {
  const first = parseAnsi('one\ntw');
  const second = parseAnsi('o\nthree', { from: first });
  assert.deepEqual(
    second.lines.map((l) => l.text),
    ['one', 'two', 'three'],
  );
  assert.deepEqual(
    first.lines.map((l) => l.text),
    ['one', 'tw'],
    'the earlier snapshot is untouched by the later write',
  );
});

test('an escape sequence cut by a chunk boundary is held, not printed', () => {
  const first = parseAnsi(`plain ${ESC}[3`);
  const second = parseAnsi('1mred', { from: first });
  assert.equal(second.lines[0]!.text, 'plain red');
  assert.deepEqual(spansOf(second, 0)[1]!.fg, { kind: 'ansi', index: 1 });
});

test('a UTF-8 character cut by a chunk boundary is held too', () => {
  // The rule `PtyHost.onData` carries for the live terminal: a `.toString()`
  // per chunk halves a multi-byte character and nothing downstream repairs it.
  const bytes = new Uint8Array([0xe2, 0x9c, 0x93, 0x20, 0x6f, 0x6b]); // "✓ ok"
  const first = parseAnsi(bytes.slice(0, 2));
  const second = parseAnsi(bytes.slice(2), { from: first });
  assert.equal(second.lines[0]!.text, '✓ ok');
});

test('an array of chunks is one capture', () => {
  const doc = parseAnsi([`${ESC}[32m`, 'ok', `${ESC}[0m`, '\ndone']);
  assert.deepEqual(
    doc.lines.map((l) => l.text),
    ['ok', 'done'],
  );
  assert.deepEqual(spansOf(doc)[0]!.fg, { kind: 'ansi', index: 2 });
});

test('maxLines keeps the tail and says how much it dropped', () => {
  const doc = parseAnsi('a\nb\nc\nd\ne\n', { maxLines: 2 });
  assert.deepEqual(
    doc.lines.map((l) => l.text),
    ['d', 'e'],
  );
  assert.equal(doc.truncated, 3);
});

// --- the palette ------------------------------------------------------------

test('the default background is nobody’s, so a log sits in the page', () => {
  const palette = ansiPalette({ foreground: '#222222', background: '#ffffff' });
  assert.deepEqual(resolveAnsiColors({}, palette), { fg: '#222222' });
  assert.deepEqual(
    resolveAnsiColors({ bg: { kind: 'ansi', index: 1 } }, palette),
    {
      fg: '#222222',
      bg: '#cd0000',
    },
  );
});

test('inverse paints a background even when neither colour was set', () => {
  const palette = ansiPalette({ foreground: '#222222', background: '#ffffff' });
  assert.deepEqual(resolveAnsiColors({ inverse: true }, palette), {
    fg: '#ffffff',
    bg: '#222222',
  });
});

test('bold promotes a palette colour to its bright twin', () => {
  const palette = ansiPalette();
  const dull = resolveAnsiColors({ fg: { kind: 'ansi', index: 1 } }, palette);
  const bright = resolveAnsiColors(
    { fg: { kind: 'ansi', index: 1 }, bold: true },
    palette,
  );
  assert.equal(dull.fg, '#cd0000');
  assert.equal(bright.fg, '#ff0000');
});

test('the palette prop replaces only the entries it has', () => {
  const palette = ansiPalette({ palette: [undefined, '#ff00aa'] });
  assert.equal(
    resolveAnsiColors({ fg: { kind: 'ansi', index: 0 } }, palette).fg,
    '#000000',
  );
  assert.equal(
    resolveAnsiColors({ fg: { kind: 'ansi', index: 1 } }, palette).fg,
    '#ff00aa',
  );
});

// --- asciinema --------------------------------------------------------------

const CAST_V2 = [
  '{"version":2,"width":100,"height":30,"title":"a build"}',
  '[0.1,"o","building"]',
  '[0.5,"o","...\\r\\n"]',
  '[1.2,"i","q"]',
  '[2.0,"o","done\\r\\n"]',
].join('\n');

test('a v2 recording reads its header and its output', () => {
  const cast = parseCast(CAST_V2);
  assert.equal(cast.header.width, 100);
  assert.equal(cast.header.title, 'a build');
  assert.equal(castOutput(cast), 'building...\r\ndone\r\n');
});

test('castOutput at a moment is what a still frame renders', () => {
  const cast = parseCast(CAST_V2);
  assert.equal(castOutput(cast, { until: 1 }), 'building...\r\n');
  assert.equal(
    stripAnsi(castOutput(cast, { until: 1 })),
    'building...',
    'and it is an ordinary capture from there on',
  );
});

test('a v1 recording arrives with absolute times', () => {
  const cast = parseCast(
    '{"version":1,"width":80,"height":24,"stdout":[[0.5,"a"],[0.25,"b"]]}',
  );
  assert.equal(cast.header.version, 1);
  assert.deepEqual(
    cast.events.map((e) => e.time),
    [0.5, 0.75],
  );
  assert.equal(castOutput(cast), 'ab');
});

test('a half-written recording keeps everything before the tear', () => {
  const cast = parseCast(`${CAST_V2}\n[3.0,"o","par`);
  assert.equal(castOutput(cast), 'building...\r\ndone\r\n');
});

test('something that is not a recording says so', () => {
  assert.throws(() => parseCast('just some text'), /no header line/);
  assert.throws(() => parseCast(''), /empty/);
});
