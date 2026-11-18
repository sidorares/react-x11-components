// A box's margins, paddings and insets as `el.style` keeps them
// (`src/html/css/box-specified.ts`): each side held to what it takes, a
// shorthand set as its longhands and read back as few as say them. WPT's
// `css-box/parsing/`, `css-position/parsing/` and `css-logical/parsing/`
// hold the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  composeShorthand,
  expandShorthand,
  specifiedValue,
} from '../../src/html/css/specified.js';

const longhandsOf = (name: string, value: string) => {
  const specified = specifiedValue(name, value);
  assert.ok(specified, `${name}: ${value} is taken`);
  return Object.fromEntries(expandShorthand(name, specified) ?? []);
};

test('a side takes a length, a percentage and auto where its kind does', () => {
  const cases: [string, string, string | null][] = [
    ['margin-top', '0', '0px'],
    ['margin-left', '-1.50PX', '-1.5px'],
    ['margin-block-start', 'auto', 'auto'],
    ['padding-top', '-1px', null],
    ['padding-right', 'auto', null],
    ['padding-inline-end', '10%', '10%'],
    ['top', 'auto', 'auto'],
    ['inset-inline-start', '10deg', null],
    ['left', '1px 2px', null],
  ];
  for (const [name, value, expected] of cases) {
    assert.equal(specifiedValue(name, value), expected, `${name}: ${value}`);
  }
});

test('margin, padding and inset set their four sides, and read back as few as say them', () => {
  assert.deepEqual(longhandsOf('margin', '1px 2px 3px 4px'), {
    'margin-top': '1px',
    'margin-right': '2px',
    'margin-bottom': '3px',
    'margin-left': '4px',
  });
  assert.deepEqual(longhandsOf('inset', '1px auto'), {
    top: '1px',
    right: 'auto',
    bottom: '1px',
    left: 'auto',
  });
  assert.equal(specifiedValue('padding', '1px 2px 1px 2px'), '1px 2px');
  assert.equal(specifiedValue('margin', '1px 1px 1px'), '1px');
  assert.equal(specifiedValue('padding', '1px -2px'), null);
  assert.equal(specifiedValue('margin', '1px 2px 3px 4px 5px'), null);
  assert.equal(
    composeShorthand('margin', (n) => (n === 'margin-left' ? '2px' : '1px')),
    '1px 1px 1px 2px',
  );
  assert.equal(
    composeShorthand('padding', (n) =>
      n === 'padding-top' ? 'inherit' : '1px',
    ),
    '',
  );
});

test('an axis shorthand sets its two sides, the second the first again', () => {
  assert.deepEqual(longhandsOf('margin-inline', '1px'), {
    'margin-inline-start': '1px',
    'margin-inline-end': '1px',
  });
  assert.deepEqual(longhandsOf('inset-block', 'auto 2%'), {
    'inset-block-start': 'auto',
    'inset-block-end': '2%',
  });
  assert.equal(specifiedValue('padding-block', '3px 3px'), '3px');
  assert.deepEqual(longhandsOf('margin', 'initial'), {
    'margin-top': 'initial',
    'margin-right': 'initial',
    'margin-bottom': 'initial',
    'margin-left': 'initial',
  });
});

test('transition-property takes property names, or none alone, and nothing else', () => {
  // CSS Transitions 1, 2.1: `<single-transition-property>#`, `none` the
  // whole value, and no CSS-wide keyword or `default` among the names
  for (const bad of [
    'one two three',
    '1, 2, 3',
    'none, one',
    'top, initial',
    'inherit, top',
    'default, top',
  ]) {
    assert.strictEqual(specifiedValue('transition-property', bad), null, bad);
  }
  for (const good of ['none', 'all', 'top, left', '--x, opacity', 'inherit']) {
    assert.notStrictEqual(specifiedValue('transition-property', good), null);
  }
});

test("a 3D transform's viewer is none or a length no less than nought, and where it stands a <position>", () => {
  // CSS Transforms 2, 7.1 and 7.2, and CSS Values 4's <position>, which has
  // no three-value form; written back across first, as Chromium writes it
  for (const bad of ['1000', '-1px', '80%', 'auto']) {
    assert.strictEqual(specifiedValue('perspective', bad), null, bad);
  }
  assert.strictEqual(specifiedValue('perspective', '0'), '0px');
  assert.notStrictEqual(specifiedValue('perspective', '10em'), null);
  assert.strictEqual(
    specifiedValue('perspective-origin', 'center left 1px'),
    null,
  );
  assert.strictEqual(specifiedValue('perspective-origin', 'left right'), null);
  assert.strictEqual(specifiedValue('perspective-origin', 'top'), 'center top');
  assert.strictEqual(
    specifiedValue('perspective-origin', 'bottom 10% right 20%'),
    'right 20% bottom 10%',
  );
  assert.strictEqual(specifiedValue('backface-visibility', 'auto'), null);
  assert.strictEqual(specifiedValue('backface-visibility', 'HIDDEN'), 'hidden');
});

test('a filter list and a corner shape that the cascade would refuse are refused by a style', () => {
  // Filter Effects 1, 5 and CSS Borders 4, 3.9: kept as written where they
  // are values, and a math function left to the cascade, which clamps it
  for (const bad of [
    'blur(-1px)',
    'brightness(30px)',
    'opacity(0.5 0.5)',
    'auto',
  ]) {
    assert.strictEqual(specifiedValue('filter', bad), null, bad);
    assert.strictEqual(specifiedValue('backdrop-filter', bad), null, bad);
  }
  for (const good of [
    'none',
    'blur(2px) grayscale(50%)',
    'brightness(calc(-10%))',
  ]) {
    assert.notStrictEqual(specifiedValue('filter', good), null, good);
  }
  assert.strictEqual(specifiedValue('corner-shape', '10px'), null);
  assert.strictEqual(
    specifiedValue('corner-shape', 'round round round round round'),
    null,
  );
  assert.strictEqual(
    specifiedValue('corner-top-left-shape', 'round bevel'),
    null,
  );
  assert.notStrictEqual(
    specifiedValue('corner-shape', 'bevel superellipse(2)'),
    null,
  );
  assert.notStrictEqual(
    specifiedValue('corner-top-shape', 'scoop notch'),
    null,
  );
});
