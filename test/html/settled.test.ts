// How much of a text's start has its levels whatever follows it
// (`settledLevels`), held to bidi-js over made-up texts.
import { test } from 'node:test';
import assert from 'node:assert';
import { bidiJs } from '../../src/html/direction.js';
import { settledLevels, settledText } from '../../src/html/layout/settled.js';
import { mulberry32 } from '../mulberry32.js';

const SEEDS = Number(process.env.SETTLED_SEEDS ?? 4000);
const FROM = Number(process.env.SETTLED_FROM ?? 0);

const LETTERS = ['a', 'b', '\u05d0', '\u05d1', '\u0627', '\u0628'];
const WEAK = ['1', '2', '\u0663', '+', '$', ',', '.', '\u0301', '\u200b'];
const NEUTRAL = [' ', ' ', '!', '\u2014', '\t'];
const BRACKETS = ['(', ')', '[', ']', '\u2329', '\u3008', '\u232a', '\u3009'];
const CONTROLS = ['\u202a', '\u202b', '\u202d', '\u202e', '\u202c']; // LRE RLE LRO RLO PDF
const ISOLATES = ['\u2066', '\u2067', '\u2068', '\u2069']; // LRI RLI FSI PDI

/** A text of the kinds a seed has in it, sparse or dense of each. */
function textOf(random: () => number, controls: boolean): string {
  const pick = (from: string[]) => from[Math.floor(random() * from.length)];
  const letters = 0.2 + random() * 0.6;
  const brackets = random() < 0.2 ? 0 : random() * 0.5;
  const explicit = controls ? 0.02 + random() * 0.2 : 0;
  const ends = random() < 0.3 ? 0.02 : 0;
  // some of them in one direction, which a letter after a bracket shows
  const run =
    random() < 0.4 ? LETTERS.slice(random() < 0.5 ? 0 : 2, 4) : LETTERS;
  const length = 8 + Math.floor(random() * (random() < 0.1 ? 400 : 60));
  let text = '';
  while (text.length < length) {
    const roll = random();
    if (roll < explicit) text += pick(random() < 0.5 ? CONTROLS : ISOLATES);
    else if (roll < explicit + ends) text += '\n';
    else if (random() < letters) text += pick(run);
    else if (random() < brackets) text += pick(BRACKETS);
    else if (random() < 0.05) text += '\ud83d\ude00';
    else text += pick(random() < 0.5 ? WEAK : NEUTRAL);
  }
  return text;
}

const shown = (text: string): string =>
  JSON.stringify(text).replace(
    /[^ -~]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );

for (const controls of [false, true]) {
  const what = controls ? 'with explicit controls' : 'with none';
  test(`the levels settled before a cut are the whole's, ${what}`, () => {
    const js = bidiJs();
    let settledTo = 0;
    let offered = 0;
    let moved = 0;
    for (let seed = FROM; seed < FROM + SEEDS; seed += 1) {
      const random = mulberry32(seed * 2 + (controls ? 1 : 0));
      const text = textOf(random, controls);
      const settled = settledText(text);
      for (let k = 0; k < 4; k += 1) {
        const from = Math.floor((random() * text.length) / 2);
        const cut = from + 1 + Math.floor(random() * (text.length - from));
        const to = cut + Math.floor(random() * (text.length - cut + 1));
        const n = settledLevels(settled, from, cut, to);
        assert.ok(n >= 0 && n <= cut - from, `${seed}: ${n} settled`);
        offered += cut - from;
        settledTo += n;
        for (const base of ['ltr', 'rtl'] as const) {
          const alone = js.getEmbeddingLevels(text.slice(from, cut), base);
          const whole = js.getEmbeddingLevels(text.slice(from, to), base);
          for (let at = 0; at < cut - from; at += 1) {
            if (alone.levels[at] === whole.levels[at]) continue;
            moved += 1;
            assert.ok(
              at >= n,
              `seed ${seed}, ${base}: ${shown(text)} from ${from}, cut at ` +
                `${cut} of ${to}: ${at} is at ${alone.levels[at]} and ` +
                `${whole.levels[at]}, with ${n} settled`,
            );
          }
        }
      }
    }
    // and says something: a fair part of each start is settled, and what
    // follows a cut did change levels before it
    assert.ok(
      settledTo > offered * (controls ? 0.15 : 0.5),
      `${settledTo} of ${offered}`,
    );
    assert.ok(moved > SEEDS / 20, `${moved} levels moved by what follows`);
  });
}

test('as much is settled as a cut leaves alone', () => {
  // the text before the cut, the text after it, and how much is settled
  const cases: [string, string, number][] = [
    // as far as its last letter: a neutral looks past it, and a number may
    ['ab @A ', 'b', 4],
    ['ab @A 12', 'b', 4],
    ['ab 12', ' c', 2],
    ['', 'a', 0],
    ['12 ', 'a', 0],
    // half a pair is no letter
    ['a@E', 'b', 1],
    // a pair closed before the cut, one that is not, and one no bracket closes
    ['a (b) c', ' d', 7],
    ['a (b c', ' d) e', 1],
    ['a (b c', ' d] e', 6],
    ['a [b (c', ' d] e', 1],
    ['a (b@Nc', ' d) e', 6],
    // past 63 open at once no more are paired
    ['a' + '('.repeat(64) + 'b', ')))c', 66],
    // an embedding or an isolate open at the cut, and one closed, whose
    // letters are in a sequence of their own
    ['a @Rb c', ' d', 1],
    ['a @Rb@P c', ' d', 7],
    ['a @Rb@P ', ' d', 1],
    ['a @Ib@J c', ' d', 7],
    ['a @Ib@J ', ' d', 1],
    ['a @Ib @Rc@J d', ' e', 10],
    // what closes the other kind closes neither
    ['a @Rb@J c', ' d', 1],
    ['a @Ib@P c', ' d', 1],
    // and a paragraph's end closes both
    ['a @R b@N c', ' d', 8],
    ['a @R b@N', ' d', 6],
  ];
  const spelled = (text: string): string =>
    text.replace(
      /@(.)/g,
      (_, c: string) =>
        ({
          A: '\u05d0',
          E: '\ud83d\ude00',
          R: '\u202b',
          P: '\u202c',
          I: '\u2067',
          J: '\u2069',
          N: '\n',
        })[c]!,
    );
  for (const [before, after, expected] of cases) {
    const cut = spelled(before);
    const text = cut + spelled(after);
    const settled = settledText(text);
    const n = settledLevels(settled, 0, cut.length, text.length);
    assert.strictEqual(n, expected, `${before}|${after}`);
    // wherever it starts and ends in a text
    const within = settledText(`x) ${'\n'}${text}${'\n'}) y`);
    assert.strictEqual(
      settledLevels(within, 4, 4 + cut.length, 4 + text.length),
      expected,
      `${before}|${after}, inside another`,
    );
  }
});

test('every bracket bidi-js pairs is among the ones a text is read for', () => {
  const js = bidiJs();
  for (let c = 0; c <= 0xffff; c += 1) {
    const char = String.fromCharCode(c);
    const opens = js.openingToClosingBracket(char) !== null;
    if (!opens && js.closingToOpeningBracket(char) === null) continue;
    assert.deepStrictEqual(
      settledText(`a${char}`).brackets,
      [{ at: 1, char, opens }],
      c.toString(16),
    );
  }
});
