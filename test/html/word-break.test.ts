// <Html> — `word-break` and `line-break: anywhere` (CSS Text 3, 5.2, 5.3):
// where a line may break when UAX #14 is not the whole answer. WPT's
// `css/css-text/word-break/` and `line-break/` hold the rest.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup } from 'react-x11/test';

import { breakOpportunities } from '../../src/html/layout/word-break.js';
import type { BreakRule } from '../../src/html/layout/word-break.js';
import { lineTextsOf, linesOf, metric, render, view } from './harness.js';

afterEach(cleanup);

const rule = (
  text: string,
  over: Partial<BreakRule> = {},
): BreakRule => ({
  start: 0,
  end: text.length,
  wordBreak: 'normal',
  anywhere: false,
  wraps: true,
  ...over,
});
const places = (text: string, rules: BreakRule[]) =>
  breakOpportunities(text, rules).map((b) => b.at);

test('break-all adds a place between letters and none at punctuation', () => {
  const text = 'ab cd. ef';
  assert.deepEqual(places(text, [rule(text)]), [3, 7, 9], 'UAX #14');
  assert.deepEqual(
    places(text, [rule(text, { wordBreak: 'break-all' })]),
    [1, 3, 4, 7, 8, 9],
    'not before the full stop, nor after the space before it',
  );
});

test('break-all keeps a mark with what it marks', () => {
  const text = 'हिंदी';
  assert.deepEqual(
    places(text, [rule(text, { wordBreak: 'break-all' })]),
    // between grapheme clusters only: हिं and दी
    [3, 5],
  );
});

test('a place break-all adds stands only where both sides break so', () => {
  const text = 'aaaabbbb';
  const rules = [
    rule(text, { end: 4 }),
    rule(text, { start: 4, wordBreak: 'break-all' }),
  ];
  assert.deepEqual(places(text, rules), [5, 6, 7, 8]);
  const held = [rule(text, { wordBreak: 'break-all', wraps: false })];
  assert.deepEqual(places(text, held), [8], 'nowrap text adds none');
});

test('keep-all takes away the places between two letters', () => {
  const text = '한글이 한글이';
  assert.deepEqual(places(text, [rule(text)]), [1, 2, 4, 5, 6, 7]);
  assert.deepEqual(
    places(text, [rule(text, { wordBreak: 'keep-all' })]),
    [4, 7],
  );
  const cjk = '日本語、日本語';
  assert.deepEqual(
    places(cjk, [rule(cjk, { wordBreak: 'keep-all' })]),
    [4, 7],
    'after the comma still',
  );
});

test('line-break: anywhere breaks between any two clusters but before a space', () => {
  const text = 'a.b c';
  assert.deepEqual(
    places(text, [rule(text, { anywhere: true })]),
    [1, 2, 4, 5],
  );
});

metric('a break-all line fills its room and carries the rest of a word down', async () => {
  const font = 'font:36px/1 sans-serif';
  const { node: whole } = await render(
    `<div id="t" style="${font};display:inline-block">Latin latin latin latin</div>`,
    900,
  );
  const full = linesOf(view(whole), 't')[0].width;
  const { node } = await render(
    `<div id="t" style="${font};word-break:break-all;width:${Math.floor(full - 5)}px">Latin latin latin latin</div>`,
    600,
  );
  const lines = lineTextsOf(view(node), 't');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('Latin latin latin lat'), lines[0]);
  assert.ok(lines[1].length <= 2, `only the end of the last word: ${lines[1]}`);
});

metric('keep-all moves a run of letters to the next line whole', async () => {
  const { node } = await render(
    '<div id="t" style="font:20px/1 sans-serif;word-break:keep-all;width:130px">한글이 한글이 한글이</div>',
    300,
  );
  for (const line of lineTextsOf(view(node), 't')) {
    assert.match(line.trim(), /^(한글이 ?)+$/u, `no word cut: ${line}`);
  }
});
