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
