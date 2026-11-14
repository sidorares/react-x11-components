// <Html> — `white-space: break-spaces` (CSS Text 3, 4.1.3): spaces kept as
// `pre-wrap` keeps them, which take room at a line's end where `pre-wrap`'s
// hang, and after each of which a line may break. WPT's
// `css/css-text/white-space/break-spaces-*` and `ws-break-spaces-*` hold the
// rest.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup } from 'react-x11/test';

import { boxOf, findById, metric, render, view } from './harness.js';

afterEach(cleanup);

interface Lined {
  lines: { textStart: number; textEnd: number; texts: { layout: object }[] }[];
  style: { whiteSpace: string; breakSpaces: boolean };
}

/** Where each of a block's lines starts and ends, from its text's start. */
function linesOf(box: Lined): [number, number][] {
  const from = box.lines[0]?.textStart ?? 0;
  return box.lines.map((l) => [l.textStart - from, l.textEnd - from]);
}

test('break-spaces is pre-wrap that breaks after its spaces, and reads back as itself', async () => {
  const { node } = await render(
    '<div id="a" style="white-space:break-spaces"><p id="b"></p></div>' +
      '<div id="c" style="white-space:break-spaces;white-space:pre-wrap"></div>' +
      '<div id="d" style="white-space-collapse:break-spaces"></div>' +
      '<div id="e" style="white-space-collapse:break-spaces;text-wrap-mode:nowrap"></div>' +
      '<div style="white-space:break-spaces"><p id="f" style="white-space-collapse:inherit"></p></div>',
  );
  const el = view(node);
  const seen = (id: string) => {
    const style = (boxOf(el, id) as unknown as Lined).style;
    return [style.whiteSpace, style.breakSpaces];
  };
  assert.deepEqual(seen('a'), ['pre-wrap', true]);
  assert.deepEqual(seen('b'), ['pre-wrap', true], 'inherited');
  assert.deepEqual(seen('c'), ['pre-wrap', false]);
  assert.deepEqual(seen('d'), ['pre-wrap', true]);
  assert.deepEqual(seen('e'), ['pre', true], 'kept, its lines unwrapped');
  assert.deepEqual(seen('f'), ['pre-wrap', true]);
  const read = (id: string) =>
    el.computedStyle(findById(el.document, id)!)!['white-space'];
  assert.equal(read('a'), 'break-spaces');
  assert.equal(read('c'), 'pre-wrap');
  assert.equal(read('e'), 'pre');
});

metric(
  'a line breaks after a space, not before one, and a run of spaces wraps',
  async () => {
    const { node } = await render(
      '<style>body{margin:0} div{font:10px monospace;white-space:break-spaces;' +
        'width:4ch}</style>' +
        // WPT's break-spaces-before-first-char-001: `X XX` fits four
        // characters, the space after it does not, so the line breaks before
        // `XX`
        '<div id="a">X XX X</div>' +
        // ws-break-spaces-applies-to-001: four spaces, one of which fits
        // after `123`, and the rest begin the next line
        '<div id="b">123    8</div>' +
        // a word as wide as its line, with no break before it: its space goes
        // on the line past its end, the first place a line may break after it
        '<div id="c">XXXX  Y</div>',
    );
    const el = view(node);
    const lines = (id: string) => linesOf(boxOf(el, id) as unknown as Lined);
    assert.deepEqual(lines('a'), [
      [0, 2],
      [2, 6],
    ]);
    assert.deepEqual(lines('b'), [
      [0, 4],
      [4, 8],
    ]);
    assert.deepEqual(lines('c'), [
      [0, 5],
      [5, 7],
    ]);
  },
);

metric(
  "a wrapped line's spaces take room, so right alignment keeps it off the edge",
  async () => {
    const { node } = await render(
      '<style>body{margin:0} div{font:10px monospace;width:5ch;' +
        'text-align:right}</style>' +
        '<div style="white-space:break-spaces"><span id="s">ab  </span>cd</div>' +
        '<div style="white-space:pre-wrap"><span id="t">ab  </span>cd</div>' +
        '<span id="m" style="font:10px monospace">x</span>',
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const char = rect('m').width;
    const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
    // `ab  cd` is six characters in five: `ab  ` and `cd`. Its spaces take
    // room, so the first line is set a character in from the left edge
    const s = rect('s');
    assert.ok(near(s.x, char), `break-spaces: ${s.x} for ${char}`);
    // where pre-wrap's hang past the edge, and the line is set flush with
    // its letters
    const t = rect('t');
    assert.ok(near(t.x, 3 * char), `pre-wrap: ${t.x} for ${3 * char}`);
  },
);

metric(
  'two lines of the same text are laid out apart, and each is drawn',
  async () => {
    // a line of a break-spaces paragraph is a layout of its own, and the
    // layout cache hands two of the same text the same layout, which the
    // paint draws once: WPT's trailing-other-space-separators-break-spaces
    // lost the second of two lines of あ so
    const { node } = await render(
      '<style>body{margin:0} div{font:10px monospace;white-space:break-spaces;' +
        'width:3ch}</style><div id="a">ab ab ab </div>',
    );
    const box = boxOf(view(node), 'a') as unknown as Lined;
    assert.deepEqual(linesOf(box), [
      [0, 3],
      [3, 6],
      [6, 9],
    ]);
    const layouts = new Set(box.lines.map((l) => l.texts[0].layout));
    assert.equal(layouts.size, 3);
  },
);
